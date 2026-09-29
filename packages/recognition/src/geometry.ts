import { INK_POINT_STRIDE } from '@folio/document'
import type { InkStroke, Rect, Transform, Vec2 } from '@folio/document'

/*
 * Local geometry helpers. Recognition works in WORLD space, so ink points
 * (stored in local space under the object transform) are converted here.
 */

/** world = translate(x,y) · rotate(rotation) · scale(sx,sy) · local */
export function applyTransform(t: Transform, x: number, y: number): Vec2 {
  const sx = x * t.scaleX
  const sy = y * t.scaleY
  const c = Math.cos(t.rotation)
  const s = Math.sin(t.rotation)
  return { x: t.x + sx * c - sy * s, y: t.y + sx * s + sy * c }
}

export function isIdentityTransform(t: Transform): boolean {
  return t.x === 0 && t.y === 0 && t.rotation === 0 && t.scaleX === 1 && t.scaleY === 1
}

/** World-space polyline of a stroke (positions only). */
export function strokeWorldPoints(stroke: InkStroke): Vec2[] {
  const pts = stroke.points
  const out: Vec2[] = []
  const identity = isIdentityTransform(stroke.transform)
  for (let i = 0; i + 1 < pts.length; i += INK_POINT_STRIDE) {
    out.push(identity ? { x: pts[i], y: pts[i + 1] } : applyTransform(stroke.transform, pts[i], pts[i + 1]))
  }
  return out
}

/** Duration of a stroke in ms (t of the last point). */
export function strokeDuration(stroke: InkStroke): number {
  const n = stroke.points.length
  if (n < INK_POINT_STRIDE) return 0
  return stroke.points[n - 1] // t is the 6th component of the last point
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function pathLength(pts: Vec2[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i])
  return l
}

export function boundsOf(pts: Vec2[]): Rect {
  if (pts.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function unionRects(rects: Rect[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Resample a polyline to `n` equidistant points (first and last preserved). */
export function resample(pts: Vec2[], n: number): Vec2[] {
  if (pts.length === 0) return []
  if (pts.length === 1) return Array.from({ length: n }, () => ({ ...pts[0] }))
  const total = pathLength(pts)
  if (total === 0) return Array.from({ length: n }, () => ({ ...pts[0] }))
  const step = total / (n - 1)
  const out: Vec2[] = [{ ...pts[0] }]
  let acc = 0
  let prev = pts[0]
  let i = 1
  while (i < pts.length && out.length < n) {
    const cur = pts[i]
    const d = dist(prev, cur)
    if (d > 0 && acc + d >= step) {
      const t = (step - acc) / d
      const q = { x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) }
      out.push(q)
      prev = q
      acc = 0
    } else {
      acc += d
      prev = cur
      i++
    }
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] })
  out[n - 1] = { ...pts[pts.length - 1] }
  return out
}

/** Distance from p to segment ab. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return dist(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Distance from p to a polyline / closed polygon outline. */
export function distToPolyline(p: Vec2, poly: Vec2[], closed: boolean): number {
  let best = Infinity
  const n = poly.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    best = Math.min(best, distToSegment(p, poly[i], poly[(i + 1) % n]))
  }
  return best
}

export function median(xs: number[]): number {
  return percentile(xs, 0.5)
}

export function percentile(xs: number[], q: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))
  return s[idx]
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** Convex hull (monotone chain). */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (pts.length < 3) return pts
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Vec2[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Vec2[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

export function polygonPerimeter(poly: Vec2[]): number {
  let l = 0
  for (let i = 0; i < poly.length; i++) l += dist(poly[i], poly[(i + 1) % poly.length])
  return l
}
