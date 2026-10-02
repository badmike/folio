import { adaptColor, defaultLineColor, isDarkColor } from '@folio/document'
import type { BackgroundPattern, Page, PageBackground } from '@folio/document'

/** Surface colour around fixed pages. */
export const DESK_COLOR = '#d9dadf'
export const DESK_COLOR_DARK = '#2b2c31'

export type PatternKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12

const PATTERN_KINDS: Record<BackgroundPattern, PatternKind> = {
  blank: 0, ruled: 1, grid: 2, dot: 3, music: 4, isometric: 5, hex: 6,
  cornell: 7, handwriting: 8, engineering: 9, isodot: 10, tablature: 11, polar: 12,
}

export function patternKind(p: BackgroundPattern): PatternKind {
  return PATTERN_KINDS[p]
}

/** Patterns that always use a single fixed level and ignore scaling, subdivisions and major lines. */
export function isFixedOnlyPattern(p: BackgroundPattern): boolean {
  return PATTERN_KINDS[p] >= 4
}

const SQRT3 = Math.sqrt(3)

/** World distance between neighbouring lines on screen, which decides when a pattern fades out. */
export function patternDensity(p: BackgroundPattern, spacing: number): number {
  switch (p) {
    case 'music': return spacing / 4
    case 'isometric': case 'isodot': return spacing * SQRT3 / 2
    case 'hex': case 'handwriting': return spacing / 2
    case 'engineering': case 'tablature': return spacing / 5
    default: return spacing
  }
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
  if (isFixedOnlyPattern(bg.pattern)) {
    // engineering fades its minor lines on its own (see newPatternCoverage), the major lines follow the spacing
    const density = bg.pattern === 'engineering' ? bg.spacing : patternDensity(bg.pattern, bg.spacing)
    const a = bg.spacing > 0 && zoom > 0 ? patternFade(density, zoom) : 0
    return a > 0 ? [{ spacing: bg.spacing, alpha: a }] : []
  }
  return patternLevels(bg.spacing, bg.subdivisions, zoom, bg.scaling ?? 'fixed')
}

/** Dot radius in screen px: dots keep their size at every zoom, like the 1px lines. */
export const DOT_RADIUS_PX = 1.25

/** Page rect in world space, as returned by `pageRect`. */
export type PageRect = { x: number; y: number; width: number; height: number }

/** Cornell cue column sits at this fraction of the page width, the summary line at this fraction of its height. */
export const CORNELL_CUE = 0.3
export const CORNELL_SUMMARY = 0.78

/** Angle between two neighbouring polar spokes. */
export const POLAR_STEP = Math.PI / 12

/** Staff-like patterns: `lines` lines spanning s, repeating every 2.5 s. Returns [line count, gap, period]. */
export function staffLayout(kind: PatternKind, s: number): [number, number, number] {
  const lines = kind === 11 ? 6 : 5
  return [lines, s / (lines - 1), s * 2.5]
}

/** Centre of the polar pattern: page centre on fixed pages, world origin otherwise. */
export function polarCenter(page?: PageRect): [number, number] {
  return page ? [page.x + page.width / 2, page.y + page.height / 2] : [0, 0]
}

/** Coverage of the fixed-only patterns (kind >= 4) at one level. Mirrors the GLSL levelCov. */
function fixedOnlyCoverage(kind: PatternKind, wx: number, wy: number, s: number, zoom: number, page?: PageRect): number {
  const line = (d: number) => Math.max(0, Math.min(1, 1 - d * zoom))
  const dot = (d: number) => Math.max(0, Math.min(1, DOT_RADIUS_PX + 0.5 - d * zoom))
  switch (kind) {
    case 4: case 11: {
      const [n, g, period] = staffLayout(kind, s)
      const m = ((wy % period) + period) % period
      const i = Math.max(0, Math.min(n - 1, Math.round(m / g)))
      return line(Math.min(Math.abs(m - i * g), period - m))
    }
    case 5: {
      const h = s * SQRT3 / 2
      return Math.max(
        line(distToLattice(wx, h)),
        line(distToLattice(-0.5 * wx + SQRT3 / 2 * wy, h)),
        line(distToLattice(-0.5 * wx - SQRT3 / 2 * wy, h)),
      )
    }
    case 7: {
      const cueX = page ? page.x + CORNELL_CUE * page.width : 0
      let c = Math.max(line(distToLattice(wy, s)), line(Math.abs(wx - cueX)))
      if (page) c = Math.max(c, line(Math.abs(wy - (page.y + CORNELL_SUMMARY * page.height))))
      return c
    }
    case 8: {
      // groups of top line, dashed midline and baseline every 1.5 s
      const period = s * 1.5
      const m = ((wy % period) + period) % period
      let c = line(Math.min(m, Math.abs(m - s), period - m))
      const dash = s / 4
      if ((((wx % dash) + dash) % dash) < dash / 2) c = Math.max(c, line(Math.abs(m - s / 2)))
      return c
    }
    case 9: {
      // major lines every s, minor lines every s/5 that fade out on their own
      const minor = s / 5
      const fade = patternFade(minor, zoom)
      return Math.max(
        line(distToLattice(wx, s)), line(distToLattice(wy, s)),
        MINOR_WEIGHT * fade * Math.max(line(distToLattice(wx, minor)), line(distToLattice(wy, minor))),
      )
    }
    case 10: {
      const h = s * SQRT3 / 2
      const i = Math.round(wx / h)
      const yOff = ((i % 2) + 2) % 2 === 1 ? s / 2 : 0
      return dot(Math.hypot(wx - i * h, distToLattice(wy - yOff, s)))
    }
    case 12: {
      const [cx, cy] = polarCenter(page)
      const dx = wx - cx, dy = wy - cy
      const r = Math.hypot(dx, dy)
      const ring = line(distToLattice(r, s))
      if (r < s) return ring
      const spoke = line(r * Math.abs(Math.sin(distToLattice(Math.atan2(dy, dx), POLAR_STEP))))
      return Math.max(ring, spoke)
    }
    default: {
      // pointy-top hexagons: nearest centre of two offset rectangular lattices
      const px = wx / s, py = wy / s
      const ox = 0.5, oy = SQRT3 / 2
      const ax = (Math.floor(px) + 0.5) - px, ay = (Math.floor(py / SQRT3) + 0.5) * SQRT3 - py
      const bx = (Math.floor(px - ox) + 0.5) + ox - px, by = (Math.floor((py - oy) / SQRT3) + 0.5) * SQRT3 + oy - py
      const useA = ax * ax + ay * ay < bx * bx + by * by
      const qx = Math.abs(useA ? ax : bx), qy = Math.abs(useA ? ay : by)
      return line((0.5 - Math.max(qx * ox + qy * oy, qx)) * s)
    }
  }
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

/**
 * Coverage over several levels (max), with optional major-line emphasis every `majorEvery` lines.
 * `page` is the page rect on fixed pages, used by the cornell and polar patterns.
 */
export function patternCoverageLevels(
  kind: PatternKind, wx: number, wy: number, levels: PatternLevel[], zoom: number, majorEvery = 0, page?: PageRect,
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
    if (kind >= 4) c = fixedOnlyCoverage(kind, wx, wy, s, zoom, page)
    else if (kind === 1) c = line(dy) * weightY
    else if (kind === 2) c = Math.max(line(dx) * weightX, line(dy) * weightY)
    else {
      const w = Math.min(weightX, weightY)
      c = Math.max(0, Math.min(1, DOT_RADIUS_PX + 0.5 - Math.hypot(dx, dy))) * (majorEvery > 1 ? w : 1)
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
export function pageRect(page: Page): PageRect | undefined {
  if (page.kind !== 'fixed') return undefined
  return { x: 0, y: 0, width: page.width ?? 794, height: page.height ?? 1123 }
}

/** Outline / name colour of frames on a page colour. */
export function frameColor(background: string): string {
  return isDarkColor(background) ? '#8a8f98' : '#9aa0a8'
}
