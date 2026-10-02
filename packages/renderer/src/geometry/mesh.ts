import earcut from 'earcut'
import { adaptColor, type ArrowObject, type InkStroke, type ShapeObject, type Vec2 } from '@folio/document'
import type { VisualTheme } from '../contract'
import { premultiplied, type RGBA } from '../color'
import { strokeFill, strokeOutline } from './ink'
import { buildArrowGeometry, buildShapeGeometry, type PathGeometry } from './rough'
import { frameColor } from '../background'

/** Floats per vertex: x, y, r, g, b, a (premultiplied). */
export const VERTEX_FLOATS = 6

/** Growable triangle-list vertex buffer, reusable across frames to avoid allocations. */
export class MeshBuilder {
  data = new Float32Array(4096 * VERTEX_FLOATS)
  /** Number of floats written. */
  length = 0

  reset(): void {
    this.length = 0
  }

  get vertexCount(): number {
    return this.length / VERTEX_FLOATS
  }

  private ensure(extraFloats: number): void {
    const need = this.length + extraFloats
    if (need <= this.data.length) return
    let cap = this.data.length
    while (cap < need) cap *= 2
    const next = new Float32Array(cap)
    next.set(this.data.subarray(0, this.length))
    this.data = next
  }

  vertex(x: number, y: number, c: RGBA): void {
    this.ensure(VERTEX_FLOATS)
    const d = this.data
    let i = this.length
    d[i++] = x; d[i++] = y; d[i++] = c[0]; d[i++] = c[1]; d[i++] = c[2]; d[i++] = c[3]
    this.length = i
  }

  tri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, c: RGBA): void {
    this.vertex(ax, ay, c)
    this.vertex(bx, by, c)
    this.vertex(cx, cy, c)
  }

  quad(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, c: RGBA): void {
    this.tri(ax, ay, bx, by, cx, cy, c)
    this.tri(ax, ay, cx, cy, dx, dy, c)
  }

  view(): Float32Array {
    return this.data.subarray(0, this.length)
  }
}

/** Fill a simple polygon (earcut). */
export function addPolygon(mb: MeshBuilder, poly: Vec2[], color: RGBA): void {
  if (poly.length < 3) return
  const flat = new Array<number>(poly.length * 2)
  for (let i = 0; i < poly.length; i++) {
    flat[i * 2] = poly[i].x
    flat[i * 2 + 1] = poly[i].y
  }
  const idx = earcut(flat)
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = poly[idx[i]], b = poly[idx[i + 1]], c = poly[idx[i + 2]]
    mb.tri(a.x, a.y, b.x, b.y, c.x, c.y, color)
  }
}

const MITER_LIMIT_COS = 0.35 // below this the corner is bevelled instead of mitred

/**
 * Thick polyline as triangles: one quad per segment, mitred joins (bevelled when
 * too sharp), butt caps extended by a quarter width for a softly rounded look.
 * Adjacent quads share join vertices so translucent strokes do not double-blend.
 */
export function addPolyline(mb: MeshBuilder, points: Vec2[], width: number, color: RGBA, closed = false): void {
  // drop zero-length segments
  const p: Vec2[] = []
  for (const q of points) {
    const l = p[p.length - 1]
    if (!l || Math.abs(l.x - q.x) > 1e-6 || Math.abs(l.y - q.y) > 1e-6) p.push(q)
  }
  if (closed && p.length > 2) {
    const a = p[0], b = p[p.length - 1]
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) p.pop()
  }
  const n = p.length
  if (n < 2) {
    if (n === 1) addDot(mb, p[0], width, color)
    return
  }
  const hw = width / 2
  const segCount = closed ? n : n - 1
  // per-segment unit normals
  const nx = new Float64Array(segCount)
  const ny = new Float64Array(segCount)
  for (let i = 0; i < segCount; i++) {
    const a = p[i], b = p[(i + 1) % n]
    const dx = b.x - a.x, dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    nx[i] = -dy / l
    ny[i] = dx / l
  }
  // Offset vectors at vertex i on the left side, for the segment ending (prev) and starting (next) there.
  const ext = hw * 0.5
  const offs = (i: number, seg: number, atStart: boolean): [number, number, number, number] => {
    // returns [lx, ly, rx, ry] offsets relative to vertex
    const prevSeg = closed ? (i - 1 + segCount) % segCount : i - 1
    const nextSeg = closed ? i % segCount : i
    const hasPrev = prevSeg >= 0
    const hasNext = nextSeg < segCount
    if (hasPrev && hasNext) {
      const mx = nx[prevSeg] + nx[nextSeg]
      const my = ny[prevSeg] + ny[nextSeg]
      const ml = Math.hypot(mx, my)
      const cosHalf = ml / 2 // = cos(theta/2) between normals
      if (cosHalf > MITER_LIMIT_COS) {
        const s = hw / (cosHalf * ml) // scale so that |miter| = hw / cosHalf
        return [mx * s, my * s, -mx * s, -my * s]
      }
    }
    void atStart
    return [nx[seg] * hw, ny[seg] * hw, -nx[seg] * hw, -ny[seg] * hw]
  }
  for (let s = 0; s < segCount; s++) {
    const i0 = s, i1 = (s + 1) % n
    const a = p[i0], b = p[i1]
    const o0 = offs(i0, s, true)
    const o1 = offs(i1, s, false)
    let ax = a.x, ay = a.y, bx = b.x, by = b.y
    if (!closed) {
      // slight extension at open ends to soften butt caps
      const dx = b.x - a.x, dy = b.y - a.y
      const l = Math.hypot(dx, dy) || 1
      if (s === 0) { ax -= (dx / l) * ext; ay -= (dy / l) * ext }
      if (s === segCount - 1) { bx += (dx / l) * ext; by += (dy / l) * ext }
    }
    mb.quad(
      ax + o0[0], ay + o0[1],
      bx + o1[0], by + o1[1],
      bx + o1[2], by + o1[3],
      ax + o0[2], ay + o0[3],
      color,
    )
  }
  // bevel wedges where the miter was rejected
  const from = closed ? 0 : 1
  const to = closed ? n : n - 1
  for (let i = from; i < to; i++) {
    const prevSeg = (i - 1 + segCount) % segCount
    const nextSeg = i % segCount
    const mx = nx[prevSeg] + nx[nextSeg]
    const my = ny[prevSeg] + ny[nextSeg]
    if (Math.hypot(mx, my) / 2 > MITER_LIMIT_COS) continue
    const v = p[i]
    // outer side: sign of cross(prev dir, next dir)
    const cross = nx[prevSeg] * ny[nextSeg] - ny[prevSeg] * nx[nextSeg]
    const sgn = cross > 0 ? -1 : 1
    mb.tri(
      v.x, v.y,
      v.x + sgn * nx[prevSeg] * hw, v.y + sgn * ny[prevSeg] * hw,
      v.x + sgn * nx[nextSeg] * hw, v.y + sgn * ny[nextSeg] * hw,
      color,
    )
  }
}

function addDot(mb: MeshBuilder, c: Vec2, width: number, color: RGBA): void {
  const r = width / 2
  const steps = 10
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * Math.PI * 2
    const a1 = ((i + 1) / steps) * Math.PI * 2
    mb.tri(c.x, c.y, c.x + r * Math.cos(a0), c.y + r * Math.sin(a0), c.x + r * Math.cos(a1), c.y + r * Math.sin(a1), color)
  }
}

export function addGeometry(mb: MeshBuilder, geo: PathGeometry, strokeColor: RGBA, fillColor: RGBA | null): void {
  if (fillColor) {
    for (const poly of geo.fills) addPolygon(mb, poly, fillColor)
    for (const line of geo.hatch) addPolyline(mb, line, geo.hatchWidth, fillColor)
  }
  for (const poly of geo.solids) addPolygon(mb, poly, strokeColor)
  for (const line of geo.strokes) addPolyline(mb, line, geo.strokeWidth, strokeColor)
}

// --- object level builders ------------------------------------------------
// `bg` = page background colour: stored colours are adapted to it (see adaptColor).

export function buildInkMesh(mb: MeshBuilder, stroke: InkStroke, bg = '#ffffff'): void {
  const outline = strokeOutline(stroke)
  addPolygon(mb, outline, premultiplied(adaptColor(stroke.style.color, bg), stroke.style.opacity))
}

/**
 * A mesh drawn through the stencil buffer, one pass after another: each pass is fan vertices
 * (from where the previous pass ended up to `fan`) followed by a quad covering them (up to `end`).
 */
export interface StencilFill {
  passes: { fan: number; end: number }[]
  /** true: any fan coverage counts (union of overlapping parts); false: nonzero winding of one outline. */
  union: boolean
}

/**
 * Ink for the stencil path: every polygon of the stroke as a triangle fan, followed by a quad
 * covering the bounds. Pass one writes the fans into the stencil buffer, pass two draws the
 * quad where it is set. Pens use nonzero winding, so outlines that cross themselves (loops in
 * handwriting) fill correctly; highlighters use the union of their band parts, so reversals
 * and sharp turns do not leave holes. Ear clipping can do neither. Each highlighter pass is a
 * separate fill, so where the stroke goes back over itself the colour builds up.
 */
export function buildInkStencilMesh(mb: MeshBuilder, stroke: InkStroke, bg = '#ffffff'): StencilFill {
  const { polygons, union, passes: counts } = strokeFill(stroke)
  const color = premultiplied(adaptColor(stroke.style.color, bg), stroke.style.opacity)
  const passes: StencilFill['passes'] = []
  let next = 0
  for (const count of counts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    const start = mb.vertexCount
    for (const o of polygons.slice(next, next + count)) {
      for (const p of o) {
        if (p.x < x0) x0 = p.x
        if (p.x > x1) x1 = p.x
        if (p.y < y0) y0 = p.y
        if (p.y > y1) y1 = p.y
      }
      for (let i = 1; i + 1 < o.length; i++) mb.tri(o[0].x, o[0].y, o[i].x, o[i].y, o[i + 1].x, o[i + 1].y, color)
    }
    next += count
    const fan = mb.vertexCount
    if (fan === start) continue
    mb.quad(x0 - 1, y0 - 1, x1 + 1, y0 - 1, x1 + 1, y1 + 1, x0 - 1, y1 + 1, color)
    passes.push({ fan, end: mb.vertexCount })
  }
  return { passes, union }
}

export function buildShapeMesh(mb: MeshBuilder, shape: ShapeObject, theme: VisualTheme, bg = '#ffffff'): void {
  const s = shape.style
  const geo = buildShapeGeometry(shape, theme)
  const stroke = shape.kind === 'frame' ? frameColor(bg) : adaptColor(s.strokeColor, bg)
  addGeometry(
    mb,
    geo,
    premultiplied(stroke, s.opacity),
    s.fillColor && shape.kind !== 'frame' ? premultiplied(adaptColor(s.fillColor, bg), s.opacity) : null,
  )
}

/** `path` = arrowPath(arrow, resolve). */
export function buildArrowMesh(mb: MeshBuilder, arrow: ArrowObject, path: Vec2[], theme: VisualTheme, bg = '#ffffff'): void {
  const geo = buildArrowGeometry(arrow, path, theme)
  addGeometry(mb, geo, premultiplied(adaptColor(arrow.style.strokeColor, bg), arrow.style.opacity), null)
}
