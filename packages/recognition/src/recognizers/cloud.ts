import type { InkStroke } from '@folio/document'
import { INK_POINT_STRIDE } from '@folio/document/model'
import { applyTransform } from '../geometry'
import { bytesToBase64, encodePng, rasterize, stackBitmaps, type RasterOptions } from '../raster'
import type { HandwritingResultEx, LocalRecognizer, RecognizeOpts } from './types'

export interface CloudRecognizerConfig {
  /** e.g. https://api.folio.example/v1 (no trailing slash needed) */
  apiBase: string
  /** Bearer token; none = not signed in. Omit when a session cookie authenticates the request. */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>
  /** Also send a compact stroke encoding (x,y,t triples, world space). Default false. */
  includeStrokes?: boolean
  fetch?: typeof fetch
  timeoutMs?: number
}

export const CLOUD_RECOGNIZER_ID = 'cloud'
/** Most lines stacked into one request image. */
export const CLOUD_MAX_LINES = 8

/** Eight lines of this size stay within the ~1568 px a vision model reads without downscaling. */
const LINE_RASTER: RasterOptions = { targetHeight: 64, padding: 16, maxWidth: 1568 }

export interface CloudLinesResult {
  /** One text per requested line, in order; '' where the model read nothing. */
  lines: string[]
  /** 0..1, for the request as a whole. */
  confidence: number
}

/**
 * Optional cloud refinement: POST `${apiBase}/ai/recognize` with one image of the stacked
 * lines. Never used as the primary recognizer; failures resolve to null.
 */
export class CloudRecognizer implements LocalRecognizer {
  readonly id = CLOUD_RECOGNIZER_ID
  constructor(private readonly cfg: CloudRecognizerConfig) {}

  async isAvailable(): Promise<boolean> {
    const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine
    if (online === false || !this.cfg.apiBase) return false
    return !this.cfg.getToken || !!(await this.cfg.getToken())
  }

  /**
   * Read up to `CLOUD_MAX_LINES` lines (one stroke group each) in a single request. `hint` is
   * context that helps the model with ambiguous words, e.g. the writer's vocabulary.
   * Resolves to null unless the model returned exactly one text per line.
   */
  async recognizeLines(lines: InkStroke[][], opts: { languages: string[]; hint?: string }): Promise<CloudLinesResult | null> {
    if (lines.length === 0 || lines.length > CLOUD_MAX_LINES || lines.some((l) => l.length === 0)) return null
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.cfg.getToken) {
      const token = await this.cfg.getToken()
      if (!token) return null
      headers.authorization = `Bearer ${token}`
    }
    const png = await encodePng(stackBitmaps(lines.map((l) => rasterize(l, LINE_RASTER))))
    const body: Record<string, unknown> = {
      image: bytesToBase64(png),
      languages: opts.languages,
      lines: lines.length,
    }
    if (opts.hint) body.hint = opts.hint
    if (this.cfg.includeStrokes) body.strokes = compactStrokes(lines.flat())
    const f = this.cfg.fetch ?? globalThis.fetch
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 15000) : undefined
    try {
      const res = await f(`${this.cfg.apiBase.replace(/\/+$/, '')}/ai/recognize`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl?.signal,
      })
      if (!res.ok) return null
      const json = (await res.json()) as { lines?: unknown; confidence?: unknown }
      if (!Array.isArray(json.lines) || json.lines.length !== lines.length) return null
      return {
        lines: json.lines.map((l) => (typeof l === 'string' ? l.trim() : '')),
        confidence: typeof json.confidence === 'number' ? Math.max(0, Math.min(1, json.confidence)) : 0.9,
      }
    } catch {
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async recognize(strokes: InkStroke[], opts: RecognizeOpts): Promise<HandwritingResultEx | null> {
    const res = await this.recognizeLines([strokes], opts)
    return res?.lines[0] ? { text: res.lines[0], confidence: res.confidence, recognizer: this.id } : null
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
