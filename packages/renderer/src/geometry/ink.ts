import earcut from 'earcut'
import { getStroke } from 'perfect-freehand'
import type { HighlighterCap, InkStroke, Vec2 } from '@folio/document'
import { STRIDE } from '../bounds'

/** Options passed to perfect-freehand for a stroke; exported for tests. */
export function freehandOptions(stroke: Pick<InkStroke, 'style' | 'pointerType'>) {
  const { style } = stroke
  if (style.tool === 'highlighter') {
    return {
      size: style.width,
      thinning: 0,
      smoothing: 0.5,
      streamline: 0.4,
      simulatePressure: false,
      start: { cap: false },
      end: { cap: false },
      last: true,
    }
  }
  const realPressure = style.pressureSensitive && stroke.pointerType !== 'mouse'
  return {
    size: style.width,
    thinning: realPressure ? 0.5 : 0.3,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: !realPressure,
    last: true,
  }
}

/** Closed outline polygon of a stroke in LOCAL coordinates. */
export function strokeOutline(stroke: InkStroke): Vec2[] {
  const pts: number[][] = []
  const p = stroke.points
  for (let i = 0; i + 1 < p.length; i += STRIDE) {
    pts.push([p[i], p[i + 1], p[i + 2] ?? 0.5])
  }
  if (!pts.length) return []
  if (stroke.style.tool === 'highlighter') {
    return highlighterOutline(pts.map(([x, y]) => ({ x, y })), stroke.style.width, stroke.style.cap ?? 'flat')
  }
  const outline = getStroke(pts, freehandOptions(stroke))
  return outline.map(([x, y]) => ({ x, y }))
}

/** Light smoothing + de-duplication of raw samples (keeps both ends). */
function smoothPath(input: Vec2[]): Vec2[] {
  const pts: Vec2[] = []
  for (const q of input) {
    const l = pts[pts.length - 1]
    if (!l || Math.hypot(q.x - l.x, q.y - l.y) > 0.05) pts.push(q)
  }
  if (pts.length < 3) return pts
  const out: Vec2[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    out.push({ x: (pts[i - 1].x + 2 * pts[i].x + pts[i + 1].x) / 4, y: (pts[i - 1].y + 2 * pts[i].y + pts[i + 1].y) / 4 })
  }
  out.push(pts[pts.length - 1])
  return out
}

/**
 * Constant-width band around a polyline with a highlighter end cap:
 * 'flat' cuts the ends square, 'round' adds half circles, 'slanted' cuts them like a
 * chisel tip (both ends at the same angle) and 'curvy' tapers them to a point.
 */
export function highlighterOutline(input: Vec2[], width: number, cap: HighlighterCap): Vec2[] {
  const pts = smoothPath(input)
  const hw = width / 2
  if (pts.length === 1) {
    const c = pts[0]
    if (cap === 'round') return circlePoly(c, hw)
    return [{ x: c.x - hw, y: c.y - hw }, { x: c.x + hw, y: c.y - hw }, { x: c.x + hw, y: c.y + hw }, { x: c.x - hw, y: c.y + hw }]
  }
  const n = pts.length
  // cumulative arc length (for tapering)
  const arc = new Float64Array(n)
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  const total = arc[n - 1] || 1
  const taperLen = Math.min(width * 1.6, total / 2)
  const halfWidthAt = (i: number): number => {
    if (cap !== 'curvy') return hw
    const t = Math.min(1, arc[i] / taperLen, (total - arc[i]) / taperLen)
    return hw * Math.max(0.05, t * t * (3 - 2 * t))
  }
  const dir = (i: number): Vec2 => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)]
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
  }
  const left: Vec2[] = []
  const right: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const d = dir(i)
    const w = halfWidthAt(i)
    left.push({ x: pts[i].x - d.y * w, y: pts[i].y + d.x * w })
    right.push({ x: pts[i].x + d.y * w, y: pts[i].y - d.x * w })
  }
  if (cap === 'slanted') {
    const skew = hw * 0.8
    const d0 = dir(0), d1 = dir(n - 1)
    left[0] = { x: left[0].x - d0.x * skew, y: left[0].y - d0.y * skew }
    right[0] = { x: right[0].x + d0.x * skew, y: right[0].y + d0.y * skew }
    left[n - 1] = { x: left[n - 1].x - d1.x * skew, y: left[n - 1].y - d1.y * skew }
    right[n - 1] = { x: right[n - 1].x + d1.x * skew, y: right[n - 1].y + d1.y * skew }
  }
  const out: Vec2[] = [...left]
  if (cap === 'round') out.push(...arcPoints(pts[n - 1], dir(n - 1), hw, false))
  for (let i = n - 1; i >= 0; i--) out.push(right[i])
  if (cap === 'round') out.push(...arcPoints(pts[0], dir(0), hw, true))
  return out
}

/** Half circle from the left band edge to the right one around `c`, facing along `d` (or against it). */
function arcPoints(c: Vec2, d: Vec2, r: number, atStart: boolean, steps = 8): Vec2[] {
  const out: Vec2[] = []
  const base = Math.atan2(d.x, -d.y) // angle of the left normal
  for (let i = 1; i < steps; i++) {
    const t = (Math.PI * i) / steps
    // end: sweep from the left normal forward to the right normal; start: from the right normal back to the left one
    const a = atStart ? base + Math.PI - t : base - t
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r })
  }
  return out
}

function circlePoly(c: Vec2, r: number, steps = 16): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < steps; i++) out.push({ x: c.x + Math.cos((i / steps) * Math.PI * 2) * r, y: c.y + Math.sin((i / steps) * Math.PI * 2) * r })
  return out
}

/** Triangulate a simple polygon; returns triangle vertex indices into `polygon`. */
export function triangulate(polygon: Vec2[]): number[] {
  if (polygon.length < 3) return []
  const flat = new Array<number>(polygon.length * 2)
  for (let i = 0; i < polygon.length; i++) {
    flat[i * 2] = polygon[i].x
    flat[i * 2 + 1] = polygon[i].y
  }
  return earcut(flat)
}
