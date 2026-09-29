import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TESSERACT_ASSETS, tesseractPaths } from '../src/assets'
import { TesseractRecognizer } from '../src/recognizers/tesseract'
import type { TesseractWorkerLike } from '../src/recognizers/tesseract'
import { letters } from './fixtures'

describe('TESSERACT_ASSETS', () => {
  it('every asset resolves to an existing file in node_modules', () => {
    const here = createRequire(import.meta.url)
    const tessDir = path.dirname(here.resolve('tesseract.js/package.json'))
    const fromTess = createRequire(path.join(tessDir, 'package.json'))
    for (const a of TESSERACT_ASSETS) {
      const [pkg, ...rest] = a.from.startsWith('@') ? [a.from.split('/').slice(0, 2).join('/'), ...a.from.split('/').slice(2)] : [a.from.split('/')[0], ...a.from.split('/').slice(1)]
      const req = a.resolveFrom === 'recognition' ? here : fromTess
      const pkgJson = req.resolve(`${pkg}/package.json`)
      expect(existsSync(path.join(path.dirname(pkgJson), ...rest)), a.from).toBe(true)
    }
  })

  it('layout matches the derived Tesseract paths', () => {
    const p = tesseractPaths('/tesseract/')
    expect(p).toEqual({ workerPath: '/tesseract/worker.min.js', corePath: '/tesseract/core', langPath: '/tesseract/lang' })
    expect(tesseractPaths('/x/').workerPath).toBe('/x/worker.min.js')
    const tos = TESSERACT_ASSETS.map((a) => a.to)
    expect(tos).toContain('worker.min.js')
    expect(tos.filter((t) => t.startsWith('core/')).every((t) => /tesseract-core(-simd|-relaxedsimd)?-lstm\.wasm\.js$/.test(t))).toBe(true)
    expect(tos).toEqual(expect.arrayContaining(['lang/eng.traineddata.gz', 'lang/deu.traineddata.gz']))
  })
})

describe('TesseractRecognizer configuration', () => {
  it('passes offline paths and reuses one lazily created worker', async () => {
    const created: { langs: string; opts: Record<string, unknown> }[] = []
    const params: Record<string, string>[] = []
    const worker: TesseractWorkerLike = {
      setParameters: async (p) => void params.push(p),
      recognize: async () => ({ data: { text: ' Hello\nWorld \n', confidence: 87 } }),
      terminate: async () => undefined,
    }
    const rec = new TesseractRecognizer({
      baseUrl: '/tesseract/',
      createWorker: async (langs, opts) => {
        created.push({ langs, opts })
        return worker
      },
    })
    expect(created).toHaveLength(0) // lazy
    const r1 = await rec.recognize(letters('a', 0, 0, 3, 0), { languages: ['en', 'de'], mode: 'line' })
    const r2 = await rec.recognize(letters('b', 0, 0, 3, 0), { languages: ['en', 'de'], mode: 'word' })
    expect(created).toHaveLength(1)
    expect(created[0].langs).toBe('eng+deu')
    expect(created[0].opts).toMatchObject({
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/core',
      langPath: '/tesseract/lang',
      cacheMethod: 'none',
      gzip: true,
    })
    expect(r1).toMatchObject({ text: 'Hello World', confidence: 0.87, recognizer: 'tesseract@7' })
    expect(r2?.text).toBe('Hello World')
    expect(params.some((p) => p.tessedit_pageseg_mode === '7')).toBe(true)
    expect(params.some((p) => p.tessedit_pageseg_mode === '8')).toBe(true)
    rec.dispose()
  })

  it('retries worker creation after a failed start', async () => {
    let attempts = 0
    const rec = new TesseractRecognizer({
      createWorker: async () => {
        if (attempts++ === 0) throw new Error('assets missing')
        return { setParameters: async () => undefined, recognize: async () => ({ data: { text: 'ok', confidence: 90 } }), terminate: async () => undefined }
      },
    })
    await expect(rec.recognize(letters('a', 0, 0, 3, 0), { languages: ['en'] })).rejects.toThrow('assets missing')
    await new Promise((r) => setTimeout(r, 0))
    expect((await rec.recognize(letters('a', 0, 0, 3, 0), { languages: ['en'] }))?.text).toBe('ok')
  })
})
