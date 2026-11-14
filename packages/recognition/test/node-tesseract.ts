import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { TesseractWorkerLike } from '../src/recognizers/tesseract'

/** Real tesseract.js worker in node, on the installed core and language files (browsers get URLs from tesseractPaths()). */
export async function createNodeTesseractWorker(langs: string): Promise<TesseractWorkerLike> {
  const req = createRequire(import.meta.url)
  const tessDir = path.dirname(req.resolve('tesseract.js/package.json'))
  const coreDir = path.dirname(createRequire(path.join(tessDir, 'package.json')).resolve('tesseract.js-core/package.json'))
  const langDir = path.join(process.env.TMPDIR ?? '/tmp', 'folio-tess-lang')
  fs.mkdirSync(langDir, { recursive: true })
  for (const lang of ['eng', 'deu']) {
    const dir = path.join(path.dirname(req.resolve(`@tesseract.js-data/${lang}/package.json`)), '4.0.0_best_int')
    fs.copyFileSync(path.join(dir, `${lang}.traineddata.gz`), path.join(langDir, `${lang}.traineddata.gz`))
  }
  const T = await import('tesseract.js')
  return (await T.createWorker(langs, 1, { corePath: coreDir, langPath: langDir, cacheMethod: 'none', gzip: true } as never)) as never
}
