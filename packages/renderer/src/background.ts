import { adaptColor, defaultLineColor } from '@folio/document'
import type { BackgroundPattern, Page, PageBackground } from '@folio/document'

/** Surface colour around fixed pages. */
export const DESK_COLOR = '#d9dadf'
export const DESK_COLOR_DARK = '#2b2c31'

export type PatternKind = 0 | 1 | 2 | 3

export function patternKind(p: BackgroundPattern): PatternKind {
  return p === 'ruled' ? 1 : p === 'grid' ? 2 : p === 'dot' ? 3 : 0
}

function distToLattice(v: number, s: number): number {
  const m = ((v % s) + s) % s
  return Math.min(m, s - m)
}

/** Screen spacing (px) below which a fixed pattern fades out completely / is fully visible. */
export const FADE_MIN_PX = 3
export const FADE_FULL_PX = 6

/** Fixed patterns fade out instead of aliasing when their on-screen spacing gets tiny. */
export function patternFade(spacing: number, zoom: number): number {
  return Math.max(0, Math.min(1, (spacing * zoom - FADE_MIN_PX) / (FADE_FULL_PX - FADE_MIN_PX)))
}

/** One rendered pattern level: world spacing and its alpha weight (0..1). */
export interface PatternLevel {
  spacing: number
  alpha: number
}

/** Minimum on-screen spacing (px) a dynamic pattern's primary level keeps. */
export const DYNAMIC_MIN_PX = 12

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

/**
 * Pattern levels to draw at `zoom`.
 * - 'fixed': the page spacing, faded out below ~6px on screen.
 * - 'dynamic': world spacing s·k^n is chosen so the primary level's screen
 *   spacing lies in [minPx, minPx·k); the next finer level (spacing/k) cross-fades
 *   in as the primary grows, so zooming never pops.
 */
export function patternLevels(
  spacing: number, subdivisions: number | undefined, zoom: number, scaling: 'fixed' | 'dynamic' = 'fixed', minPx = DYNAMIC_MIN_PX,
): PatternLevel[] {
  if (!(spacing > 0) || !(zoom > 0)) return []
  if (scaling !== 'dynamic') {
    const a = patternFade(spacing, zoom)
    return a > 0 ? [{ spacing, alpha: a }] : []
  }
  const k = Math.max(2, Math.round(subdivisions ?? 5))
  const px = spacing * zoom
  // smallest n with px·k^n >= minPx
  let n = Math.ceil(Math.log(minPx / px) / Math.log(k) - 1e-9)
  let primary = spacing * Math.pow(k, n)
  let ppx = primary * zoom
  // guard against float error at the boundaries
  while (ppx < minPx - 1e-9) { n++; primary *= k; ppx *= k }
  while (ppx >= minPx * k - 1e-9) { n--; primary /= k; ppx /= k }
  const t = Math.log(ppx / minPx) / Math.log(k) // 0 at minPx .. 1 at minPx·k
  const fine = smoothstep(t)
  const out: PatternLevel[] = [{ spacing: primary, alpha: 1 }]
  if (fine > 0.001) out.push({ spacing: primary / k, alpha: fine })
  return out
}

/** Effective levels for a page background at `zoom`. */
export function backgroundLevels(bg: PageBackground, zoom: number): PatternLevel[] {
  if (bg.pattern === 'blank') return []
  return patternLevels(bg.spacing, bg.subdivisions, zoom, bg.scaling ?? 'fixed')
}

/** Alpha weight of non-major lines when major lines are emphasised. */
export const MINOR_WEIGHT = 0.55

/**
 * Coverage (0..1) of the background pattern at a world position. This is the CPU
 * reference for the GLSL in the WebGL renderer (kept in sync by hand).
 */
export function patternCoverage(kind: PatternKind, wx: number, wy: number, spacing: number, zoom: number): number {
  return patternCoverageLevels(kind, wx, wy, spacing > 0 ? [{ spacing, alpha: patternFade(spacing, zoom) }] : [], zoom)
}

/** Coverage over several levels (max), with optional major-line emphasis every `majorEvery` lines. */
export function patternCoverageLevels(
  kind: PatternKind, wx: number, wy: number, levels: PatternLevel[], zoom: number, majorEvery = 0,
): number {
  if (kind === 0) return 0
  let best = 0
  for (const lv of levels) {
    const s = lv.spacing
    if (!(s > 0) || lv.alpha <= 0) continue
    const dx = distToLattice(wx, s) * zoom
    const dy = distToLattice(wy, s) * zoom
    const line = (d: number) => Math.max(0, Math.min(1, 1 - d))
    let weightX = 1, weightY = 1
    if (majorEvery > 1) {
      weightX = Math.round(wx / s) % majorEvery === 0 ? 1 : MINOR_WEIGHT
      weightY = Math.round(wy / s) % majorEvery === 0 ? 1 : MINOR_WEIGHT
    }
    let c = 0
    if (kind === 1) c = line(dy) * weightY
    else if (kind === 2) c = Math.max(line(dx) * weightX, line(dy) * weightY)
    else {
      const r = Math.max(1.25, zoom)
      const w = Math.min(weightX, weightY)
      c = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(dx, dy))) * (majorEvery > 1 ? w : 1)
    }
    best = Math.max(best, c * lv.alpha)
  }
  return best
}

/** Line colours the app used as defaults; they are replaced by a contrasting default on other backgrounds. */
const STALE_LINE_COLORS = new Set(['#d0d4da', '#c9ced6', '#3a3f45', '#e5e7eb', '#d9dde3'])

/** Pattern line/dot colour to draw on this page (readable on light and dark pages). */
export function patternColor(bg: PageBackground): string {
  const lc = (bg.lineColor || '').toLowerCase()
  if (!lc || STALE_LINE_COLORS.has(lc)) return defaultLineColor(bg.color)
  return adaptColor(bg.lineColor, bg.color)
}

/** Page rect in world space for fixed pages, undefined for infinite pages. */
export function pageRect(page: Page): { x: number; y: number; width: number; height: number } | undefined {
  if (page.kind !== 'fixed') return undefined
  return { x: 0, y: 0, width: page.width ?? 794, height: page.height ?? 1123 }
}
