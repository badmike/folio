import type { InkStroke } from '@folio/document'
import { rasterizeToPng } from '../raster'
import type { RasterOptions } from '../raster'
import { tesseractPaths } from '../assets'
import { absoluteUrl, toTesseractLang } from './types'
import type { HandwritingResultEx, LocalRecognizer, RecognizeOpts } from './types'

export const TESSERACT_RECOGNIZER_ID = 'tesseract@7'

/** Subset of the tesseract.js worker API that we use (keeps tests/fakes simple). */
export interface TesseractWorkerLike {
  setParameters(p: Record<string, string>): Promise<unknown>
  recognize(image: unknown): Promise<{ data: { text: string; confidence: number } }>
  reinitialize?(langs: string, oem?: number): Promise<unknown>
  terminate(): Promise<unknown>
}

export interface TesseractConfig {
  /** Directory URL under which the app serves TESSERACT_ASSETS. Default '/tesseract/'. */
  baseUrl?: string
  /** Explicit overrides of the derived paths. */
  workerPath?: string
  corePath?: string
  langPath?: string
  /** Languages ('en'/'de' or Tesseract codes) loaded at start. Default ['en', 'de']. */
  languages?: string[]
  /** tesseract.js cacheMethod. Default 'none': files are same-origin/precached by the app shell. */
  cacheMethod?: 'write' | 'readOnly' | 'refresh' | 'none'
  /** Test seam: replace worker creation. */
  createWorker?: (langs: string, opts: Record<string, unknown>) => Promise<TesseractWorkerLike>
  raster?: RasterOptions
}

/**
 * Local OCR of rasterized ink. One lazily-created tesseract.js worker is reused; all
 * paths point at self-hosted files so it works fully offline.
 */
export class TesseractRecognizer implements LocalRecognizer {
  readonly id = TESSERACT_RECOGNIZER_ID
  private worker: Promise<TesseractWorkerLike> | null = null
  private currentLangs = ''
  private currentPsm = ''
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly cfg: TesseractConfig = {}) {}

  async isAvailable(): Promise<boolean> {
    return typeof WebAssembly === 'object'
  }

  private langString(langs?: string[]): string {
    const l = (langs && langs.length ? langs : this.cfg.languages ?? ['en', 'de']).map(toTesseractLang)
    return [...new Set(l)].join('+')
  }

  /** Build the options passed to `createWorker` (exported for verification/tests). */
  workerOptions(): Record<string, unknown> {
    const d = tesseractPaths(this.cfg.baseUrl ?? '/tesseract/')
    return {
      workerPath: absoluteUrl(this.cfg.workerPath ?? d.workerPath),
      corePath: absoluteUrl(this.cfg.corePath ?? d.corePath),
      langPath: absoluteUrl(this.cfg.langPath ?? d.langPath),
      cacheMethod: this.cfg.cacheMethod ?? 'none',
      gzip: true,
      // Nested worker from a module worker: load the (same-origin) script directly.
      workerBlobURL: false,
    }
  }

  private async ensureWorker(langs: string): Promise<TesseractWorkerLike> {
    if (!this.worker) {
      const opts = this.workerOptions()
      this.currentLangs = langs
      this.worker = (async () => {
        const create =
          this.cfg.createWorker ??
          (async (l: string, o: Record<string, unknown>) => {
            const T = await import('tesseract.js')
            // OEM 1 = LSTM only (matches the *-lstm core builds we ship)
            return (await T.createWorker(l, 1, o as never)) as unknown as TesseractWorkerLike
          })
        const w = await create(langs, opts)
        await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '150' })
        return w
      })()
      this.worker.catch(() => {
        this.worker = null // allow retry after a failed start (e.g. missing assets)
      })
    }
    const w = await this.worker
    if (langs !== this.currentLangs && w.reinitialize) {
      await w.reinitialize(langs, 1)
      this.currentLangs = langs
    }
    return w
  }

  recognize(strokes: InkStroke[], opts: RecognizeOpts): Promise<HandwritingResultEx | null> {
    // tesseract.js runs one job at a time per worker: serialise our own access too.
    const run = this.queue.then(() => this.doRecognize(strokes, opts))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async doRecognize(strokes: InkStroke[], opts: RecognizeOpts): Promise<HandwritingResultEx | null> {
    if (strokes.length === 0) return null
    const { png } = await rasterizeToPng(strokes, this.cfg.raster)
    const w = await this.ensureWorker(this.langString(opts.languages.length ? opts.languages : this.cfg.languages))
    // PSM 7 = single text line, 8 = single word, 6 = uniform block
    const psm = opts.mode === 'word' ? '8' : opts.mode === 'block' ? '6' : '7'
    if (psm !== this.currentPsm) {
      await w.setParameters({ tessedit_pageseg_mode: psm })
      this.currentPsm = psm
    }
    const { data } = await w.recognize(png)
    const text = (data.text ?? '').replace(/\s*\n+\s*/g, ' ').trim()
    if (!text) return null
    return { text, confidence: Math.max(0, Math.min(1, (data.confidence ?? 0) / 100)), recognizer: this.id }
  }

  dispose(): void {
    const w = this.worker
    this.worker = null
    if (w) void w.then((x) => x.terminate()).catch(() => undefined)
  }
}
