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

/**
 * Constant-width highlighter outline with an end cap: perfect-freehand builds the band (its
 * joins never fold over on sharp turns, which would break triangulation); the caps are
 * 'flat' (cut square), 'round', 'curvy' (tapered) or 'slanted' (the flat cap sheared like a
 * chisel tip, applied as a post-process on the cap vertices).
 */
export function highlighterOutline(input: Vec2[], width: number, cap: HighlighterCap): Vec2[] {
  const pts = input.map((p) => [p.x, p.y, 0.5])
  if (!pts.length) return []
  const taper = cap === 'curvy' ? Math.min(width * 1.6, pathLength(input) / 2) : 0
  const round = cap === 'round'
  const outline = getStroke(pts, {
    size: width, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last: true,
    start: { cap: round || cap === 'curvy', taper: taper || false },
    end: { cap: round || cap === 'curvy', taper: taper || false },
  }).map(([x, y]) => ({ x, y }))
  if (cap !== 'slanted' || input.length < 2) return outline
  // shear the cap vertices along the stroke direction: left corner forward, right corner back
  const hw = width / 2
  const skew = hw * 0.8
  const shear = (endPt: Vec2, dir: Vec2): void => {
    for (const p of outline) {
      if (Math.hypot(p.x - endPt.x, p.y - endPt.y) > hw * 1.15) continue
      const side = Math.sign(dir.x * (p.y - endPt.y) - dir.y * (p.x - endPt.x)) || 1
      p.x += dir.x * skew * side
      p.y += dir.y * skew * side
    }
  }
  const n = input.length
  shear(input[n - 1], unit(input[n - 1], input[Math.max(0, n - 4)]))
  shear(input[0], unit(input[0], input[Math.min(n - 1, 3)]))
  return outline
}

function unit(to: Vec2, from: Vec2): Vec2 {
  const l = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: (to.x - from.x) / l, y: (to.y - from.y) / l }
}

function pathLength(p: Vec2[]): number {
  let l = 0
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)
  return l
}

/** Fill geometry of a stroke: convex/simple polygons plus how to combine them. */
export interface StrokeFill {
  polygons: Vec2[][]
  /**
   * true: the polygons overlap and their UNION is the stroke (highlighter band parts);
   * false: one outline filled with the nonzero rule (pen).
   */
  union: boolean
}

export function strokeFill(stroke: InkStroke): StrokeFill {
  if (stroke.style.tool === 'highlighter') {
    const pts: Vec2[] = []
    const p = stroke.points
    for (let i = 0; i + 1 < p.length; i += STRIDE) pts.push({ x: p[i], y: p[i + 1] })
    return { polygons: highlighterParts(pts, stroke.style.width, stroke.style.cap ?? 'flat'), union: true }
  }
  const o = strokeOutline(stroke)
  return { polygons: o.length > 2 ? [o] : [], union: false }
}

/** Drop near-duplicate samples and smooth lightly (keeps both ends). */
function cleanPath(input: Vec2[]): Vec2[] {
  const pts: Vec2[] = []
  for (const q of input) {
    const l = pts[pts.length - 1]
    if (!l || Math.hypot(q.x - l.x, q.y - l.y) > 0.5) pts.push(q)
  }
  if (pts.length < 3) return pts
  const out: Vec2[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    out.push({ x: (pts[i - 1].x + 2 * pts[i].x + pts[i + 1].x) / 4, y: (pts[i - 1].y + 2 * pts[i].y + pts[i + 1].y) / 4 })
  }
  out.push(pts[pts.length - 1])
  return out
}

function disc(c: Vec2, r: number, steps = 12): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < steps; i++) out.push({ x: c.x + Math.cos((i / steps) * Math.PI * 2) * r, y: c.y + Math.sin((i / steps) * Math.PI * 2) * r })
  return out
}

/**
 * A constant-width highlighter band as overlapping convex parts: one quad per segment and a
 * disc at every joint. Their union is the stroke, however sharply the path turns or doubles
 * back (a single outline polygon folds over itself there and fills wrongly). Ends: 'flat'
 * leaves the end quads square, 'round' adds discs, 'slanted' shears the end quads like a
 * chisel tip, 'curvy' tapers the width towards both ends.
 */
export function highlighterParts(input: Vec2[], width: number, cap: HighlighterCap): Vec2[][] {
  const pts = cleanPath(input)
  const hw = width / 2
  if (!pts.length) return []
  if (pts.length === 1) {
    const c = pts[0]
    return [cap === 'round' || cap === 'curvy' ? disc(c, hw) : [{ x: c.x - hw, y: c.y - hw }, { x: c.x + hw, y: c.y - hw }, { x: c.x + hw, y: c.y + hw }, { x: c.x - hw, y: c.y + hw }]]
  }
  const n = pts.length
  const arc = new Float64Array(n)
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  const total = arc[n - 1] || 1
  const taperLen = Math.min(width * 1.6, total / 2)
  const half = (i: number): number => {
    if (cap !== 'curvy') return hw
    const t = Math.min(1, arc[i] / taperLen, (total - arc[i]) / taperLen)
    return hw * Math.max(0.06, t * t * (3 - 2 * t))
  }
  const parts: Vec2[][] = []
  for (let i = 0; i + 1 < n; i++) {
    const a = pts[i], b = pts[i + 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len
    const nx = -dy, ny = dx
    const wa = half(i), wb = half(i + 1)
    const quad = [
      { x: a.x + nx * wa, y: a.y + ny * wa }, { x: b.x + nx * wb, y: b.y + ny * wb },
      { x: b.x - nx * wb, y: b.y - ny * wb }, { x: a.x - nx * wa, y: a.y - ny * wa },
    ]
    if (cap === 'slanted') {
      // chisel tip: one corner of each end runs ahead, the other stays back (same slant at both ends)
      const skew = Math.min(hw * 0.8, len)
      if (i === 0) { quad[0] = { x: quad[0].x - dx * skew, y: quad[0].y - dy * skew }; quad[3] = { x: quad[3].x + dx * skew, y: quad[3].y + dy * skew } }
      if (i === n - 2) { quad[1] = { x: quad[1].x - dx * skew, y: quad[1].y - dy * skew }; quad[2] = { x: quad[2].x + dx * skew, y: quad[2].y + dy * skew } }
    }
    parts.push(quad)
  }
  for (let i = 1; i < n - 1; i++) parts.push(disc(pts[i], half(i)))
  if (cap === 'round') parts.push(disc(pts[0], hw), disc(pts[n - 1], hw))
  return parts
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
