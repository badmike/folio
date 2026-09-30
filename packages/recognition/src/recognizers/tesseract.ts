import type { InkStroke } from '@folio/document'
import { rasterizeToPng } from '../raster'
import type { RasterOptions } from '../raster'
import { tesseractPaths } from '../assets'
import { cleanRecognizedText } from '../text'
import { absoluteUrl, toTesseractLang } from './types'
import type { HandwritingResultEx, LocalRecognizer, RecognizeOpts } from './types'

export const TESSERACT_RECOGNIZER_ID = 'tesseract@7'

/** Glyphs that never stand alone in handwritten notes but show up as OCR noise. */
const CHAR_BLACKLIST = '|¦~^'
/** Words below this confidence (0..1) are dropped when they are just one or two symbols. */
const MIN_SYMBOL_WORD_CONFIDENCE = 0.15

export interface TesseractWord {
  text: string
  /** 0..100 */
  confidence: number
}

/** The part of a tesseract.js page result we read. `blocks` is only filled when requested. */
export interface TesseractPage {
  text: string
  /** 0..100 */
  confidence: number
  blocks?: { paragraphs: { lines: { words: TesseractWord[] }[] }[] }[] | null
}

/** Subset of the tesseract.js worker API that we use (keeps tests/fakes simple). */
export interface TesseractWorkerLike {
  setParameters(p: Record<string, string>): Promise<unknown>
  recognize(image: unknown, options?: Record<string, unknown>, output?: { blocks?: boolean }): Promise<{ data: TesseractPage }>
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
        // The dictionaries (load_system_dawg / load_freq_dawg) stay on: they help with
        // handwriting, and they are init-only parameters anyway.
        await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '150', tessedit_char_blacklist: CHAR_BLACKLIST })
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
    const { data } = await w.recognize(png, {}, { blocks: true })
    const { text: raw, confidence } = readPage(data)
    const text = cleanRecognizedText(raw)
    if (!text) return null
    return { text, confidence: Math.max(0, Math.min(1, confidence)), recognizer: this.id }
  }

  dispose(): void {
    const w = this.worker
    this.worker = null
    if (w) void w.then((x) => x.terminate()).catch(() => undefined)
  }
}

/**
 * Text and 0..1 confidence of a page. With word results, low-confidence symbol words are
 * dropped and the confidence is the length-weighted mean of the remaining words, which
 * tracks what the user sees better than the block confidence.
 */
function readPage(data: TesseractPage): { text: string; confidence: number } {
  const words = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)))
  if (words.length === 0) return { text: data.text ?? '', confidence: (data.confidence ?? 0) / 100 }
  const kept = words.filter(
    (w) => !(w.confidence / 100 < MIN_SYMBOL_WORD_CONFIDENCE && /^[^\p{L}\p{N}]{1,2}$/u.test(w.text.trim())),
  )
  let sum = 0
  let weight = 0
  for (const w of kept) {
    const len = Math.max(1, w.text.trim().length)
    sum += (w.confidence / 100) * len
    weight += len
  }
  return { text: kept.map((w) => w.text).join(' '), confidence: weight ? sum / weight : 0 }
}
