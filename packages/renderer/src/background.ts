import type { BackgroundPattern, Page } from '@folio/document'

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

/** Pattern lines/dots fade out when so dense they turn into noise. */
export function patternFade(spacing: number, zoom: number): number {
  return Math.max(0, Math.min(1, (spacing * zoom - 3) / 5))
}

/**
 * Coverage (0..1) of the background pattern at a world position. This is the CPU
 * reference for the GLSL in the WebGL renderer (kept in sync by hand).
 */
export function patternCoverage(kind: PatternKind, wx: number, wy: number, spacing: number, zoom: number): number {
  if (kind === 0 || spacing <= 0) return 0
  const dx = distToLattice(wx, spacing) * zoom
  const dy = distToLattice(wy, spacing) * zoom
  const line = (d: number) => Math.max(0, Math.min(1, 1 - d))
  let c = 0
  if (kind === 1) c = line(dy)
  else if (kind === 2) c = Math.max(line(dx), line(dy))
  else {
    const r = Math.max(1.25, zoom)
    c = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(dx, dy)))
  }
  return c * patternFade(spacing, zoom)
}

/** Page rect in world space for fixed pages, undefined for infinite pages. */
export function pageRect(page: Page): { x: number; y: number; width: number; height: number } | undefined {
  if (page.kind !== 'fixed') return undefined
  return { x: 0, y: 0, width: page.width ?? 794, height: page.height ?? 1123 }
}
