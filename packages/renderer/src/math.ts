import type { Rect, Transform, Vec2 } from '@folio/document'

/** 2D affine matrix [a,b,c,d,e,f]: x' = a·x + c·y + e ; y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number]

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** world = translate · rotate · scale (per Transform doc). */
export function transformMatrix(t: Transform): Mat {
  const c = Math.cos(t.rotation)
  const s = Math.sin(t.rotation)
  return [c * t.scaleX, s * t.scaleX, -s * t.scaleY, c * t.scaleY, t.x, t.y]
}

export function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

export function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-12) return null
  const id = 1 / det
  const a = m[3] * id
  const b = -m[1] * id
  const c = -m[2] * id
  const d = m[0] * id
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}

export function applyMat(m: Mat, x: number, y: number): Vec2 {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

export function applyMatAll(m: Mat, pts: Vec2[]): Vec2[] {
  return pts.map((p) => applyMat(m, p.x, p.y))
}

/** Column-major 3x3 for GL uniformMatrix3fv. */
export function toMat3(m: Mat, out: Float32Array | number[] = new Float32Array(9)): Float32Array | number[] {
  out[0] = m[0]; out[1] = m[1]; out[2] = 0
  out[3] = m[2]; out[4] = m[3]; out[5] = 0
  out[6] = m[4]; out[7] = m[5]; out[8] = 1
  return out
}

/** Mean scale factor of a transform (for converting world tolerances to local). */
export function meanScale(t: Transform): number {
  const s = Math.sqrt(Math.abs(t.scaleX * t.scaleY))
  return s > 1e-9 ? s : 1
}

export function rectCorners(r: Rect): Vec2[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ]
}

export function boundsOfPoints(pts: Vec2[]): Rect {
  if (!pts.length) return { x: 0, y: 0, width: 0, height: 0 }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function polygonArea(poly: Vec2[]): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y)
  return Math.abs(a / 2)
}

export function pointInRect(p: Vec2, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

/** Segment/segment intersection; returns param t along a→b or null. */
export function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number | null {
  const rx = b.x - a.x, ry = b.y - a.y
  const sx = d.x - c.x, sy = d.y - c.y
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-12) return null
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null
}

export function segmentIntersectsRect(a: Vec2, b: Vec2, r: Rect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true
  const c = rectCorners(r)
  for (let i = 0; i < 4; i++) if (segmentIntersection(a, b, c[i], c[(i + 1) % 4]) !== null) return true
  return false
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
}

export function unionRects(rs: Rect[]): Rect | undefined {
  if (!rs.length) return undefined
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of rs) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
