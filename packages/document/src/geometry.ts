import {
  INK_POINT_STRIDE,
  type ArrowObject,
  type CanvasObject,
  type InkPoint,
  type InkStroke,
  type ObjectId,
  type Rect,
  type TextObject,
  type Transform,
  type Vec2,
} from './types'

export type ObjectResolver = (id: ObjectId) => CanvasObject | undefined

// ---------------------------------------------------------------------------
// Ink point encoding
// ---------------------------------------------------------------------------

export function inkPoints(stroke: Pick<InkStroke, 'points'>): InkPoint[] {
  const p = stroke.points
  const out: InkPoint[] = []
  for (let i = 0; i + INK_POINT_STRIDE <= p.length; i += INK_POINT_STRIDE) {
    out.push({ x: p[i], y: p[i + 1], pressure: p[i + 2], tiltX: p[i + 3], tiltY: p[i + 4], t: p[i + 5] })
  }
  return out
}

export function encodeInkPoints(points: InkPoint[]): number[] {
  const out = new Array<number>(points.length * INK_POINT_STRIDE)
  let o = 0
  for (const q of points) {
    out[o++] = q.x
    out[o++] = q.y
    out[o++] = q.pressure
    out[o++] = q.tiltX
    out[o++] = q.tiltY
    out[o++] = q.t
  }
  return out
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/** 2D affine matrix [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number]

export function toMatrix(t: Transform): Matrix {
  const cos = Math.cos(t.rotation)
  const sin = Math.sin(t.rotation)
  return [cos * t.scaleX, sin * t.scaleX, -sin * t.scaleY, cos * t.scaleY, t.x, t.y]
}

/** m1 · m2 (apply m2 first). */
export function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

/**
 * Compose parent · child into a single Transform. Exact only when the result has no
 * shear (e.g. uniform parent scale or unrotated child); otherwise the closest TRS fit.
 */
export function transformsCompose(parent: Transform, child: Transform): Transform {
  const m = multiplyMatrix(toMatrix(parent), toMatrix(child))
  const scaleX = Math.hypot(m[0], m[1])
  const rotation = Math.atan2(m[1], m[0])
  const det = m[0] * m[3] - m[1] * m[2]
  const scaleY = scaleX === 0 ? 0 : det / scaleX
  return { x: m[4], y: m[5], rotation, scaleX, scaleY }
}

/** local -> world */
export function applyTransform(t: Transform, p: Vec2): Vec2 {
  const cos = Math.cos(t.rotation)
  const sin = Math.sin(t.rotation)
  const sx = p.x * t.scaleX
  const sy = p.y * t.scaleY
  return { x: t.x + cos * sx - sin * sy, y: t.y + sin * sx + cos * sy }
}

/** world -> local */
export function invertTransform(t: Transform, p: Vec2): Vec2 {
  const cos = Math.cos(t.rotation)
  const sin = Math.sin(t.rotation)
  const dx = p.x - t.x
  const dy = p.y - t.y
  const rx = cos * dx + sin * dy
  const ry = -sin * dx + cos * dy
  return { x: t.scaleX === 0 ? 0 : rx / t.scaleX, y: t.scaleY === 0 ? 0 : ry / t.scaleY }
}

// ---------------------------------------------------------------------------
// Rect helpers
// ---------------------------------------------------------------------------

export function boundsUnion(rects: Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of rects) {
    if (r.x < x0) x0 = r.x
    if (r.y < y0) y0 = r.y
    if (r.x + r.width > x1) x1 = r.x + r.width
    if (r.y + r.height > y1) y1 = r.y + r.height
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
}

/** True when `outer` fully contains `inner` (rect or point). */
export function rectContains(outer: Rect, inner: Rect | Vec2): boolean {
  if ('width' in inner) {
    return (
      inner.x >= outer.x && inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height
    )
  }
  return inner.x >= outer.x && inner.x <= outer.x + outer.width && inner.y >= outer.y && inner.y <= outer.y + outer.height
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

/** Distance from point p to the closed segment a-b. */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Distance from a point to a rect (0 when inside). */
export function distanceToRect(p: Vec2, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width))
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height))
  return Math.hypot(dx, dy)
}

// ---------------------------------------------------------------------------
// Object bounds
// ---------------------------------------------------------------------------

/** Rough text metrics used when no layout engine is available. */
export function estimateTextSize(o: Pick<TextObject, 'text' | 'fontSize' | 'width'>): { width: number; height: number } {
  const lines = o.text.split('\n')
  const charW = o.fontSize * 0.55
  let maxChars = 0
  for (const l of lines) maxChars = Math.max(maxChars, l.length)
  let width = maxChars * charW
  let lineCount = lines.length
  if (o.width !== undefined) {
    width = Math.min(width, o.width)
    // wrapped lines
    const perLine = Math.max(1, Math.floor(o.width / charW))
    lineCount = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0)
    width = o.width
  }
  return { width: Math.max(width, o.fontSize * 0.5), height: lineCount * o.fontSize * 1.25 }
}

/**
 * Bounds in the object's local space. Groups need `resolve` (their bounds are the union
 * of their children's world bounds; group transforms are not applied to children).
 */
export function localBounds(obj: CanvasObject, resolve?: ObjectResolver, depth = 0): Rect {
  switch (obj.type) {
    case 'ink': {
      const p = obj.points
      if (p.length < INK_POINT_STRIDE) return { x: 0, y: 0, width: 0, height: 0 }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let i = 0; i + 1 < p.length; i += INK_POINT_STRIDE) {
        if (p[i] < x0) x0 = p[i]
        if (p[i] > x1) x1 = p[i]
        if (p[i + 1] < y0) y0 = p[i + 1]
        if (p[i + 1] > y1) y1 = p[i + 1]
      }
      const pad = (obj.style?.width ?? 0) / 2
      return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad }
    }
    case 'text': {
      const s = estimateTextSize(obj)
      const x = obj.align === 'center' ? -s.width / 2 : obj.align === 'right' ? -s.width : 0
      return { x, y: 0, width: s.width, height: s.height }
    }
    case 'shape':
    case 'image':
      return { x: 0, y: 0, width: obj.width, height: obj.height }
    case 'arrow': {
      const { start, end } = resolve ? resolveArrowEndpoints(obj, resolve, depth) : obj
      const wps = obj.waypoints
      if (!wps?.length && obj.arrowType !== 'elbow') return rectFromPoints(start, end)
      // curved / elbow arrows bulge beyond their end points: include waypoints and a route margin
      const xs = [start.x, end.x, ...(wps ?? []).map((p) => p.x)]
      const ys = [start.y, end.y, ...(wps ?? []).map((p) => p.y)]
      const m = obj.arrowType === 'elbow' ? 24 : 8
      const x0 = Math.min(...xs) - m, y0 = Math.min(...ys) - m
      return { x: x0, y: y0, width: Math.max(...xs) + m - x0, height: Math.max(...ys) + m - y0 }
    }
    case 'group': {
      if (!resolve || depth > 4) return { x: 0, y: 0, width: 0, height: 0 }
      const rects: Rect[] = []
      for (const cid of obj.childIds) {
        const c = resolve(cid)
        if (c) rects.push(worldBounds(c, resolve, depth + 1))
      }
      return boundsUnion(rects) ?? { x: 0, y: 0, width: 0, height: 0 }
    }
  }
}

function rectFromPoints(a: Vec2, b: Vec2): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** Axis-aligned bounds in world space of the transformed local bounds. */
export function worldBounds(obj: CanvasObject, resolve?: ObjectResolver, depth = 0): Rect {
  const lb = localBounds(obj, resolve, depth)
  if (obj.type === 'arrow' || obj.type === 'group') return lb // already world space
  const t = obj.transform
  if (t.rotation === 0 && t.scaleX === 1 && t.scaleY === 1 && t.x === 0 && t.y === 0) return lb
  const corners = [
    applyTransform(t, { x: lb.x, y: lb.y }),
    applyTransform(t, { x: lb.x + lb.width, y: lb.y }),
    applyTransform(t, { x: lb.x + lb.width, y: lb.y + lb.height }),
    applyTransform(t, { x: lb.x, y: lb.y + lb.height }),
  ]
  const xs = corners.map((c) => c.x)
  const ys = corners.map((c) => c.y)
  const x0 = Math.min(...xs), y0 = Math.min(...ys)
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

/** Exit point of the ray from `from` (inside r) toward `to`, on r's boundary. */
function rayExit(r: Rect, from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return from
  let tMin = Infinity
  if (dx > 0) tMin = Math.min(tMin, (r.x + r.width - from.x) / dx)
  else if (dx < 0) tMin = Math.min(tMin, (r.x - from.x) / dx)
  if (dy > 0) tMin = Math.min(tMin, (r.y + r.height - from.y) / dy)
  else if (dy < 0) tMin = Math.min(tMin, (r.y - from.y) / dy)
  if (!(tMin >= 0) || tMin >= 1) return from // target point lies inside the rect
  return { x: from.x + dx * tMin, y: from.y + dy * tMin }
}

/**
 * World endpoints of an arrow. A bound endpoint is where the line from the target's anchor
 * (default center) toward the other endpoint crosses the target's world-bounds edge.
 */
export function resolveArrowEndpoints(
  arrow: ArrowObject,
  resolve: ObjectResolver,
  depth = 0,
): { start: Vec2; end: Vec2 } {
  const anchorOf = (b: ArrowObject['startBinding']): { anchor: Vec2; bounds: Rect } | undefined => {
    if (!b || depth > 2) return undefined
    const target = resolve(b.objectId)
    if (!target || target.id === arrow.id) return undefined
    const bounds = worldBounds(target, resolve, depth + 1)
    const a = b.anchor ?? { x: 0.5, y: 0.5 }
    return { anchor: { x: bounds.x + bounds.width * a.x, y: bounds.y + bounds.height * a.y }, bounds }
  }
  const s = anchorOf(arrow.startBinding)
  const e = anchorOf(arrow.endBinding)
  const sPoint = s ? s.anchor : arrow.start
  const ePoint = e ? e.anchor : arrow.end
  return {
    start: s ? rayExit(s.bounds, s.anchor, ePoint) : arrow.start,
    end: e ? rayExit(e.bounds, e.anchor, sPoint) : arrow.end,
  }
}
