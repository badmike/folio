import type { InkStroke } from '@folio/document'
import { INK_POINT_STRIDE } from '@folio/document'
import { detectLanguage } from '../text'
import { applyTransform } from '../geometry'
import type { HandwritingResultEx, LocalRecognizer, RecognizeOpts } from './types'

/*
 * Minimal local typings for the W3C Handwriting Recognition API
 * (https://wicg.github.io/handwriting-recognition/), available on Chromium.
 */
interface HWPoint {
  x: number
  y: number
  t?: number
}
interface HWStroke {
  addPoint(p: HWPoint): void
}
interface HWPrediction {
  text: string
}
interface HWDrawing {
  addStroke(s: HWStroke): void
  getPrediction(): Promise<HWPrediction[]>
  clear(): void
}
interface HWRecognizer {
  startDrawing(hints?: Record<string, unknown>): HWDrawing
  finish(): void
}
interface HWNavigator {
  createHandwritingRecognizer?(c: { languages: string[] }): Promise<HWRecognizer>
  queryHandwritingRecognizerSupport?(q: { languages: string[] }): Promise<{ languages?: boolean }>
}
type HWStrokeCtor = new () => HWStroke

export const WEB_HANDWRITING_ID = 'web-handwriting'

/** Recognizer backed by the browser-native Handwriting Recognition API. */
export class WebHandwritingRecognizer implements LocalRecognizer {
  readonly id = WEB_HANDWRITING_ID
  private recognizers = new Map<string, Promise<HWRecognizer | null>>()
  private support = new Map<string, Promise<boolean>>()

  constructor(private readonly nav: HWNavigator | undefined = (globalThis as { navigator?: HWNavigator }).navigator) {}

  private get strokeCtor(): HWStrokeCtor | undefined {
    return (globalThis as { HandwritingStroke?: HWStrokeCtor }).HandwritingStroke
  }

  private supported(lang: string): Promise<boolean> {
    let p = this.support.get(lang)
    if (!p) {
      const nav = this.nav
      p =
        nav?.createHandwritingRecognizer && nav.queryHandwritingRecognizerSupport && this.strokeCtor
          ? nav.queryHandwritingRecognizerSupport({ languages: [lang] }).then((r) => !!r?.languages, () => false)
          : Promise.resolve(false)
      this.support.set(lang, p)
    }
    return p
  }

  async isAvailable(languages: string[] = ['en']): Promise<boolean> {
    for (const l of languages) if (await this.supported(l)) return true
    return false
  }

  private getRecognizer(lang: string): Promise<HWRecognizer | null> {
    let p = this.recognizers.get(lang)
    if (!p) {
      p = this.supported(lang).then((ok) => (ok ? this.nav!.createHandwritingRecognizer!({ languages: [lang] }) : null)).catch(() => null)
      this.recognizers.set(lang, p)
    }
    return p
  }

  async recognize(strokes: InkStroke[], opts: RecognizeOpts): Promise<HandwritingResultEx | null> {
    const Ctor = this.strokeCtor
    if (!Ctor || strokes.length === 0) return null
    const candidates: { lang: string; text: string; alternatives: string[] }[] = []
    for (const lang of opts.languages.length ? opts.languages : ['en']) {
      const rec = await this.getRecognizer(lang)
      if (!rec) continue
      const drawing = rec.startDrawing({ recognitionType: 'text', inputType: 'pen' })
      for (const s of [...strokes].sort((a, b) => a.startedAt - b.startedAt)) {
        const hs = new Ctor()
        for (let i = 0; i + INK_POINT_STRIDE - 1 < s.points.length; i += INK_POINT_STRIDE) {
          const w = applyTransform(s.transform, s.points[i], s.points[i + 1])
          hs.addPoint({ x: w.x, y: w.y, t: s.startedAt + s.points[i + 5] })
        }
        drawing.addStroke(hs)
      }
      try {
        const pred = await drawing.getPrediction()
        if (pred.length) candidates.push({ lang, text: pred[0].text, alternatives: pred.slice(1).map((p) => p.text) })
      } catch {
        /* recognizer failed for this language: try the next one */
      } finally {
        drawing.clear()
      }
    }
    const usable = candidates.filter((c) => c.text.trim())
    if (usable.length === 0) return null
    // The API gives no confidence: prefer the candidate whose detected language matches its recognizer.
    // (German evidence is positive; an 'en' match is only the default of the heuristic.)
    const base = (l: string) => l.split('-')[0]
    const best =
      usable.find((c) => base(c.lang) === 'de' && detectLanguage(c.text) === 'de') ??
      usable.find((c) => detectLanguage(c.text) === base(c.lang)) ??
      usable[0]
    return {
      text: best.text.trim(),
      confidence: 0.8,
      alternatives: best.alternatives,
      language: best.lang.split('-')[0],
      recognizer: this.id,
    }
  }

  dispose(): void {
    for (const p of this.recognizers.values()) void p.then((r) => r?.finish())
    this.recognizers.clear()
  }
}
