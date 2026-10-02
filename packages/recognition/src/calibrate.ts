import type { InkStroke } from '@folio/document'
import { strokeWorldPoints } from './geometry'
import { cer, type RasterTuning } from './profile'
import { estimateSlant } from './raster'

/**
 * Calibration: the user writes sentences with known text, and image prep for OCR is tuned
 * to their handwriting by trying variants one setting at a time (lean, then size, then
 * line width) and keeping what reads best.
 */

export interface CalibrationSample {
  strokes: InkStroke[]
  /** What the user was asked to write. */
  text: string
}

/** Reads strokes with the given image prep (OCR). */
export type CalibrationReader = (strokes: InkStroke[], raster: RasterTuning) => Promise<string>

export interface CalibrationResult {
  /** Best image prep found (the defaults when nothing beat them). */
  tuning: RasterTuning
  /** True when `tuning` reads clearly better than the defaults. */
  improved: boolean
  /** Mean character error rate (0..1) with the defaults and with `tuning`. */
  before: number
  after: number
  /** What OCR read for each sample with `tuning`. */
  readings: string[]
}

export const DEFAULT_TUNING: RasterTuning = { slant: 0, targetHeight: 100, lineWidthScale: 1 }

/** Tuned prep has to beat the defaults by this much (mean character error rate). */
const MIN_GAIN = 0.01
const HEIGHTS = [80, 130]
const WIDTHS = [0.75, 1.35]

export async function calibrate(
  samples: CalibrationSample[],
  read: CalibrationReader,
  onProgress?: (done: number, total: number) => void,
): Promise<CalibrationResult> {
  const lean = estimateSlant(samples.flatMap((s) => s.strokes.map(strokeWorldPoints)))
  const slants = [...new Set([lean / 2, lean, lean * 1.3].map((a) => Math.round(a * 100) / 100))].filter((a) => a !== 0)
  const total = (1 + slants.length + HEIGHTS.length + WIDTHS.length) * samples.length
  let done = 0
  const tried = new Map<string, { score: number; readings: string[] }>()

  const evaluate = async (t: RasterTuning) => {
    const key = `${t.slant}|${t.targetHeight}|${t.lineWidthScale}`
    let r = tried.get(key)
    if (!r) {
      const readings: string[] = []
      for (const s of samples) {
        readings.push(await read(s.strokes, t).catch(() => ''))
        onProgress?.(++done, total)
      }
      r = { score: mean(samples.map((s, i) => cer(readings[i], s.text))), readings }
      tried.set(key, r)
    }
    return r
  }

  const base = await evaluate(DEFAULT_TUNING)
  let best = { tuning: DEFAULT_TUNING, ...base }
  const stage = async (variants: RasterTuning[]) => {
    for (const t of variants) {
      const r = await evaluate(t)
      if (r.score < best.score) best = { tuning: t, ...r }
    }
  }
  await stage(slants.map((slant) => ({ ...best.tuning, slant })))
  await stage(HEIGHTS.map((targetHeight) => ({ ...best.tuning, targetHeight })))
  await stage(WIDTHS.map((lineWidthScale) => ({ ...best.tuning, lineWidthScale })))

  onProgress?.(total, total)
  const improved = base.score - best.score >= MIN_GAIN
  return improved
    ? { tuning: best.tuning, improved, before: base.score, after: best.score, readings: best.readings }
    : { tuning: DEFAULT_TUNING, improved, before: base.score, after: base.score, readings: base.readings }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
