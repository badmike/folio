import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = resolve(webRoot, '../server')

export function hasCargo(): boolean {
  return spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0
}

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => res(port))
    })
  })
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): void {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`)
}

async function waitFor(url: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timeout waiting for ${url}`)
}

export interface Stack {
  apiBase: string
  webBase: string
  stop(): void
}

/** Build + start folio-server (dev auth, temp db/assets) and a preview of the web app pointing at it. */
export async function startStack(): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), 'folio-sync-e2e-'))
  const apiPort = await freePort()
  const webPort = await freePort()
  const apiBase = `http://127.0.0.1:${apiPort}`
  const webBase = `http://localhost:${webPort}`
  const children: ChildProcess[] = []

  run('cargo', ['build', '--manifest-path', join(serverDir, 'Cargo.toml')], serverDir)
  const meta = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', join(serverDir, 'Cargo.toml')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const targetDir = (JSON.parse(meta.stdout) as { target_directory: string }).target_directory
  const server = spawn(join(targetDir, 'debug', 'folio-server'), [], {
    cwd: dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      FOLIO_AUTH_DEV: 'true',
      FOLIO_BIND: `127.0.0.1:${apiPort}`,
      DATABASE_URL: `sqlite://${join(dir, 'folio.db')}`,
      FOLIO_ASSETS_DIR: join(dir, 'assets'),
      FOLIO_CORS_ORIGINS: webBase,
      FOLIO_LOG: 'warn',
    },
  })
  children.push(server)

  // Separate outDir so the regular `dist` (used by the main e2e suite) is untouched.
  run('pnpm', ['exec', 'vite', 'build', '--outDir', 'dist-sync', '--emptyOutDir'], webRoot, { VITE_API_BASE: apiBase })
  const web = spawn(join(webRoot, 'node_modules/.bin/vite'), ['preview', '--outDir', 'dist-sync', '--port', String(webPort), '--strictPort', '--host', 'localhost'], {
    cwd: webRoot,
    stdio: 'inherit',
  })
  children.push(web)

  await waitFor(`${apiBase}/health`)
  await waitFor(webBase)
  return {
    apiBase,
    webBase,
    stop() {
      for (const c of children) c.kill('SIGTERM')
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}
