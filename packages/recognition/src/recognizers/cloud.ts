import type { InkStroke } from '@folio/document'
import { INK_POINT_STRIDE } from '@folio/document/model'
import { applyTransform } from '../geometry'
import { bytesToBase64, rasterizeToPng } from '../raster'
import type { HandwritingResultEx, LocalRecognizer, RecognizeOpts } from './types'

export interface CloudRecognizerConfig {
  /** e.g. https://api.folio.example/v1 (no trailing slash needed) */
  apiBase: string
  getToken: () => string | null | undefined | Promise<string | null | undefined>
  /** Also send a compact stroke encoding (x,y,t triples, world space). Default false. */
  includeStrokes?: boolean
  fetch?: typeof fetch
  timeoutMs?: number
}

export const CLOUD_RECOGNIZER_ID = 'cloud'

/**
 * Optional cloud refinement: POST `${apiBase}/ai/recognize` with a PNG of the ink.
 * Never used as the primary recognizer; failures resolve to null.
 */
export class CloudRecognizer implements LocalRecognizer {
  readonly id = CLOUD_RECOGNIZER_ID
  constructor(private readonly cfg: CloudRecognizerConfig) {}

  async isAvailable(): Promise<boolean> {
    const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine
    if (online === false || !this.cfg.apiBase) return false
    return !!(await this.cfg.getToken())
  }

  async recognize(strokes: InkStroke[], opts: RecognizeOpts): Promise<HandwritingResultEx | null> {
    if (strokes.length === 0) return null
    const token = await this.cfg.getToken()
    if (!token) return null
    const { png } = await rasterizeToPng(strokes)
    const body: Record<string, unknown> = {
      image: bytesToBase64(png),
      languages: opts.languages,
    }
    if (this.cfg.includeStrokes) body.strokes = compactStrokes(strokes)
    const f = this.cfg.fetch ?? globalThis.fetch
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 15000) : undefined
    try {
      const res = await f(`${this.cfg.apiBase.replace(/\/+$/, '')}/ai/recognize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: ctrl?.signal,
      })
      if (!res.ok) return null
      const json = (await res.json()) as { text?: string; confidence?: number; language?: string }
      if (typeof json.text !== 'string' || !json.text.trim()) return null
      return {
        text: json.text.trim(),
        confidence: typeof json.confidence === 'number' ? Math.max(0, Math.min(1, json.confidence)) : 0.9,
        language: json.language,
        recognizer: this.id,
      }
    } catch {
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/** Per stroke: flat [x, y, t, x, y, t, ...] in world space (1 decimal), t = absolute ms. */
export function compactStrokes(strokes: InkStroke[]): number[][] {
  return strokes.map((s) => {
    const out: number[] = []
    for (let i = 0; i + INK_POINT_STRIDE - 1 < s.points.length; i += INK_POINT_STRIDE) {
      const w = applyTransform(s.transform, s.points[i], s.points[i + 1])
      out.push(Math.round(w.x * 10) / 10, Math.round(w.y * 10) / 10, s.startedAt + s.points[i + 5])
    }
    return out
  })
}
