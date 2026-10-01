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
 * 'flat' (cut square), 'round', 'curvy' (wavy cut) or 'slanted' (the flat cap sheared like a
 * chisel tip, applied as a post-process on the cap vertices).
 */
export function highlighterOutline(input: Vec2[], width: number, cap: HighlighterCap): Vec2[] {
  const pts = input.map((p) => [p.x, p.y, 0.5])
  if (!pts.length) return []
  const round = cap === 'round'
  const outline = getStroke(pts, {
    size: width, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last: true,
    start: { cap: round },
    end: { cap: round },
  }).map(([x, y]) => ({ x, y }))
  if (cap === 'curvy' && input.length > 1) {
    const depth = Math.min(width * 0.15, pathLength(input) / 3)
    const ends = [
      { origin: input[0], direction: unit(input[1], input[0]) },
      { origin: input[input.length - 1], direction: unit(input[input.length - 2], input[input.length - 1]) },
    ]
    const result: Vec2[] = []
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length]
      const end = ends.find(({ origin, direction }) => [a, b].every((p) => Math.abs((p.x - origin.x) * direction.x + (p.y - origin.y) * direction.y) < 1e-6))
      if (!end) { result.push(a); continue }
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / width * 32))
      for (let j = 0; j < steps; j++) {
        const t = j / steps
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t
        const side = ((y - end.origin.y) * end.direction.x - (x - end.origin.x) * end.direction.y) / width + 0.5
        const d = waveOffset(side, depth)
        result.push({ x: x + end.direction.x * d, y: y + end.direction.y * d })
      }
    }
    return result
  }
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

function disc(c: Vec2, r: number): Vec2[] {
  // Keep round edges within 0.05 world units of the circle, including wide markers.
  const steps = Math.max(32, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.05 / r, 1)) / 4) * 4)
  const out: Vec2[] = []
  for (let i = 0; i < steps; i++) out.push({ x: c.x + Math.cos((i / steps) * Math.PI * 2) * r, y: c.y - Math.sin((i / steps) * Math.PI * 2) * r })
  return out
}

/** Clip a convex part to one side of a cap's cut line. */
function clipCap(polygon: Vec2[], origin: Vec2, direction: Vec2, slant: number, end: boolean): Vec2[] {
  const distance = (p: Vec2) => {
    const x = p.x - origin.x, y = p.y - origin.y
    const d = x * direction.x + y * direction.y + slant * (y * direction.x - x * direction.y)
    return end ? -d : d
  }
  const out: Vec2[] = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length]
    const da = distance(a), db = distance(b)
    if (da >= 0) out.push(a)
    if ((da < 0) !== (db < 0)) {
      const t = da / (da - db)
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return out
}

/** Two gentle waves across a full-width cut, split into convex strips for the stencil union. */
function waveOffset(t: number, depth: number): number {
  return depth * (0.5 + 0.5 * Math.sin(t * Math.PI * 4))
}

function wavyCap(origin: Vec2, direction: Vec2, radius: number, depth: number): Vec2[][] {
  const point = (t: number, d: number): Vec2 => {
    const side = (2 * t - 1) * radius
    return { x: origin.x + direction.x * d - direction.y * side, y: origin.y + direction.y * d + direction.x * side }
  }
  const parts: Vec2[][] = []
  for (let i = 0; i < 32; i++) {
    const a = i / 32, b = (i + 1) / 32
    parts.push([point(a, waveOffset(a, depth)), point(b, waveOffset(b, depth)), point(b, depth), point(a, depth)])
  }
  return parts
}

/**
 * A constant-width highlighter band as overlapping convex parts: one quad per segment and a
 * disc at each turn. Their union is the stroke, however sharply the path turns or doubles
 * back (a single outline polygon folds over itself there and fills wrongly). Ends: 'flat'
 * leaves the end quads square, 'round' adds discs, 'slanted' shears the end quads like a
 * chisel tip, 'curvy' uses a shallow wavy cut across the full width. All parts have the same winding
 * so Canvas2D can fill their union in one pass without overlapping alpha.
 */
export function highlighterParts(input: Vec2[], width: number, cap: HighlighterCap): Vec2[][] {
  let pts = cleanPath(input)
  const hw = width / 2
  if (!pts.length) return []
  if (pts.length === 1) {
    const c = pts[0]
    return [cap === 'round' || cap === 'curvy' ? disc(c, hw) : [{ x: c.x - hw, y: c.y - hw }, { x: c.x + hw, y: c.y - hw }, { x: c.x + hw, y: c.y + hw }, { x: c.x - hw, y: c.y + hw }]]
  }
  // Collinear samples must not shorten a chisel cap or leave joints across its cut.
  if (cap === 'slanted') {
    const reduced = [pts[0]]
    for (let i = 1; i < pts.length - 1; i++) {
      const a = reduced[reduced.length - 1], b = pts[i], c = pts[i + 1]
      const ab = unit(b, a), bc = unit(c, b)
      if (Math.abs(ab.x * bc.y - ab.y * bc.x) > 1e-6 || ab.x * bc.x + ab.y * bc.y < 0) reduced.push(b)
    }
    reduced.push(pts[pts.length - 1])
    pts = reduced
  }
  const n = pts.length
  const arc = new Float64Array(n)
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  const total = arc[n - 1] || 1
  const skew = cap === 'slanted' ? Math.min(hw * 0.8, total / 2) : 0
  const startDir = unit(pts[1], pts[0]), endDir = unit(pts[n - 1], pts[n - 2])
  const waveDepth = cap === 'curvy' ? Math.min(hw * 0.3, total / 3) : 0
  const startCut = { x: pts[0].x + startDir.x * waveDepth, y: pts[0].y + startDir.y * waveDepth }
  const endCut = { x: pts[n - 1].x - endDir.x * waveDepth, y: pts[n - 1].y - endDir.y * waveDepth }
  const cut = (polygon: Vec2[], from: number, to: number) => {
    if (cap === 'round') return polygon
    if (from < hw + skew + waveDepth) polygon = clipCap(polygon, startCut, startDir, skew / hw, false)
    if (total - to < hw + skew + waveDepth) polygon = clipCap(polygon, endCut, endDir, skew / hw, true)
    return polygon
  }
  const parts: Vec2[][] = []
  for (let i = 0; i + 1 < n; i++) {
    const a = pts[i], b = pts[i + 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len
    const nx = -dy, ny = dx
    const wa = hw, wb = hw
    const quad = [
      { x: a.x + nx * wa, y: a.y + ny * wa }, { x: b.x + nx * wb, y: b.y + ny * wb },
      { x: b.x - nx * wb, y: b.y - ny * wb }, { x: a.x - nx * wa, y: a.y - ny * wa },
    ]
    if (cap === 'slanted') {
      // Extend the terminal band, then cut it and nearby joins along the same chisel line.
      if (i === 0) for (const j of [0, 3]) { quad[j].x -= dx * skew; quad[j].y -= dy * skew }
      if (i === n - 2) for (const j of [1, 2]) { quad[j].x += dx * skew; quad[j].y += dy * skew }
    }
    parts.push(cut(quad, arc[i], arc[i + 1]))
  }
  for (let i = 1; i < n - 1; i++) {
    const before = unit(pts[i], pts[i - 1]), after = unit(pts[i + 1], pts[i])
    if (Math.abs(before.x * after.y - before.y * after.x) < 1e-6 && before.x * after.x + before.y * after.y > 0) continue
    parts.push(cut(disc(pts[i], hw), arc[i], arc[i]))
  }
  if (cap === 'round') parts.push(disc(pts[0], hw), disc(pts[n - 1], hw))
  if (cap === 'curvy') {
    parts.push(...wavyCap(pts[0], startDir, hw, waveDepth), ...wavyCap(pts[n - 1], { x: -endDir.x, y: -endDir.y }, hw, waveDepth))
  }
  return parts.filter((p) => p.length > 2)
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
