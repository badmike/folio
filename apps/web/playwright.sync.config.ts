import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const exe = process.env.PW_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)

/**
 * Multi-device sync e2e against the real Rust server (apps/server). The spec starts the server
 * and a web build on free ports itself (see e2e-sync/sync.spec.ts) and skips when `cargo` is missing.
 * Run with: pnpm --filter @folio/web test:e2e:sync
 */
export default defineConfig({
  testDir: 'e2e-sync',
  outputDir: 'test-results-sync',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    actionTimeout: 15_000,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath: exe,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
})
