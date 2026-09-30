import type { ArrowObject, CanvasObject, InkStroke, Rect, ShapeObject, Vec2 } from '@folio/document'
import type { ResolveArrow } from './contract'
import { arrowPath, resolveArrowEndpoints } from './arrows'
import { inkLocalPoints, localBounds, localOutline, objectWorldBounds, type Resolve } from './bounds'
import {
  applyMat, distToSegment, invert, meanScale, pointInPolygon, pointInRect, rectCorners, rectsOverlap,
  segmentIntersectsRect, transformMatrix,
} from './math'
import { shapeOutline } from './shapes'

export { pointInPolygon } from './math'

/** Local rect of a frame's name label (drawn above the top-left corner). */
export function frameLabelRect(s: ShapeObject): Rect {
  const size = s.labelSize ?? FRAME_LABEL_SIZE
  const w = Math.min(s.width, Math.max(40, (s.label?.length ?? 0) * size * 0.55))
  return { x: 0, y: -size * 1.5, width: w, height: size * 1.5 }
}
/** Font size of frame names (world units). */
export const FRAME_LABEL_SIZE = 16

function toLocal(obj: CanvasObject, p: Vec2): Vec2 | null {
  const inv = invert(transformMatrix(obj.transform))
  return inv ? applyMat(inv, p.x, p.y) : null
}

function polylineDistance(p: Vec2, pts: Vec2[], closed: boolean): number {
  let best = Infinity
  const n = closed ? pts.length : pts.length - 1
  for (let i = 0; i < n; i++) best = Math.min(best, distToSegment(p, pts[i], pts[(i + 1) % pts.length]))
  if (pts.length === 1) best = Math.hypot(p.x - pts[0].x, p.y - pts[0].y)
  return best
}

function inkHalfWidth(s: InkStroke): number {
  return (s.style.width * (s.style.pressureSensitive ? 1.1 : 1)) / 2
}

function arrowEnds(a: ArrowObject, resolve: Resolve, resolver: ResolveArrow = resolveArrowEndpoints) {
  return resolver(a, resolve)
}

/**
 * Does the world point hit the object (within `tolerance` world units)?
 * Ink: near polyline; shapes: near outline, inside when filled or labelled;
 * text/image: inside box; arrows: near shaft; groups: any child.
 */
export function hitTestObject(obj: CanvasObject, world: Vec2, tolerance: number, resolve: Resolve): boolean {
  switch (obj.type) {
    case 'arrow': {
      return polylineDistance(world, arrowPath(obj, resolve), false) <= obj.style.strokeWidth / 2 + tolerance
    }
    case 'group':
      return obj.childIds.some((id) => {
        const c = resolve(id)
        return !!c && hitTestObject(c, world, tolerance, resolve)
      })
    default:
  }
  const p = toLocal(obj, world)
  if (!p) return false
  const tol = tolerance / meanScale(obj.transform)
  switch (obj.type) {
    case 'ink': {
      const pts = inkLocalPoints(obj)
      if (!pts.length) return false
      return polylineDistance(p, pts, false) <= inkHalfWidth(obj) + tol
    }
    case 'shape': {
      const s: ShapeObject = obj
      const half = s.style.strokeWidth / 2 + tol
      if (s.kind === 'line') return polylineDistance(p, shapeOutline('line', s.width, s.height, { points: s.points }), false) <= half
      const outline = shapeOutline(s.kind, s.width, s.height, { roundness: s.style.roundness })
      // a blur mask is a solid patch; a frame is only hit on its border and name
      if (s.kind === 'blur') return pointInPolygon(p, outline) || polylineDistance(p, outline, true) <= half
      if (s.kind === 'frame') return polylineDistance(p, outline, true) <= half || pointInRect(p, frameLabelRect(s))
      if (polylineDistance(p, outline, true) <= half) return true
      if (s.style.fillColor || s.label) return pointInPolygon(p, outline)
      return false
    }
    case 'text':
    case 'image': {
      const b = localBounds(obj)!
      return pointInRect(p, { x: b.x - tol, y: b.y - tol, width: b.width + 2 * tol, height: b.height + 2 * tol })
    }
    default:
      return false
  }
}

/** Roughly evenly spaced points along a polyline (>= 2, includes both ends and every vertex of short paths). */
function resamplePath(path: Vec2[], perUnit: number): Vec2[] {
  if (path.length < 3) {
    const a = path[0], b = path[path.length - 1]
    const out: Vec2[] = []
    for (let i = 0; i <= 10; i++) out.push({ x: a.x + ((b.x - a.x) * i) / 10, y: a.y + ((b.y - a.y) * i) / 10 })
    return out
  }
  void perUnit
  const out: Vec2[] = []
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1]
    const n = Math.max(1, Math.min(6, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 30)))
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })
  }
  out.push(path[path.length - 1])
  return out
}

/** World-space polyline(s) approximating the object's geometry (for rect / lasso tests). */
function worldSamples(obj: CanvasObject, resolve: Resolve, maxPts = 200): Vec2[] {
  if (obj.type === 'arrow') {
    return resamplePath(arrowPath(obj, resolve), 12)
  }
  if (obj.type === 'group') return obj.childIds.flatMap((id) => {
    const c = resolve(id)
    return c ? worldSamples(c, resolve, maxPts) : []
  })
  const m = transformMatrix(obj.transform)
  if (obj.type === 'ink') {
    const pts = inkLocalPoints(obj)
    const step = Math.max(1, Math.ceil(pts.length / maxPts))
    const out: Vec2[] = []
    for (let i = 0; i < pts.length; i += step) out.push(applyMat(m, pts[i].x, pts[i].y))
    if (pts.length && (pts.length - 1) % step !== 0) out.push(applyMat(m, pts[pts.length - 1].x, pts[pts.length - 1].y))
    return out
  }
  const b = localBounds(obj)
  if (!b) return []
  // box outline + centre + edge midpoints
  const out: Vec2[] = []
  const corners = rectCorners(b)
  for (let i = 0; i < 4; i++) {
    const a = corners[i], c = corners[(i + 1) % 4]
    for (let k = 0; k < 4; k++) out.push(applyMat(m, a.x + ((c.x - a.x) * k) / 4, a.y + ((c.y - a.y) * k) / 4))
  }
  out.push(applyMat(m, b.x + b.width / 2, b.y + b.height / 2))
  return out
}

/** Does the object touch the world rect (marquee / eraser / crossing select)? */
export function objectIntersectsRect(obj: CanvasObject, rect: Rect, resolve: Resolve): boolean {
  const wb = objectWorldBounds(obj, resolve, (a) => arrowEnds(a, resolve))
  if (!wb || !rectsOverlap(wb, rect)) return false
  if (obj.type === 'group') return obj.childIds.some((id) => {
    const c = resolve(id)
    return !!c && objectIntersectsRect(c, rect, resolve)
  })
  const m = transformMatrix(obj.transform)
  if (obj.type === 'arrow') {
    const path = arrowPath(obj, resolve)
    for (let i = 0; i + 1 < path.length; i++) if (segmentIntersectsRect(path[i], path[i + 1], rect)) return true
    return false
  }
  if (obj.type === 'ink') {
    const pts = inkLocalPoints(obj).map((q) => applyMat(m, q.x, q.y))
    const grown = { x: rect.x - inkHalfWidth(obj), y: rect.y - inkHalfWidth(obj), width: rect.width + inkHalfWidth(obj) * 2, height: rect.height + inkHalfWidth(obj) * 2 }
    if (pts.length === 1) return pointInRect(pts[0], grown)
    for (let i = 0; i + 1 < pts.length; i++) if (segmentIntersectsRect(pts[i], pts[i + 1], grown)) return true
    return false
  }
  // shapes / text / images: oriented outline vs rect
  const outline = localOutline(obj)
  if (!outline) return false
  const poly = outline.map((q) => applyMat(m, q.x, q.y))
  const filled = obj.type !== 'shape' || !!obj.style.fillColor || (!!obj.label && obj.kind !== 'frame') || obj.kind === 'blur'
  if (obj.type === 'shape' && obj.kind === 'line') {
    const l = shapeOutline('line', obj.width, obj.height, { points: obj.points }).map((q) => applyMat(m, q.x, q.y))
    for (let i = 0; i + 1 < l.length; i++) if (segmentIntersectsRect(l[i], l[i + 1], rect)) return true
    return false
  }
  for (let i = 0; i < poly.length; i++) if (segmentIntersectsRect(poly[i], poly[(i + 1) % poly.length], rect)) return true
  if (filled) {
    // rect entirely inside polygon
    return pointInPolygon({ x: rect.x, y: rect.y }, poly)
  }
  return false
}

/** True when most (>= 50%) of the object's sampled points lie inside the lasso polygon. */
export function objectIntersectsLasso(obj: CanvasObject, polygon: Vec2[], resolve: Resolve): boolean {
  if (polygon.length < 3) return false
  const pts = worldSamples(obj, resolve)
  if (!pts.length) return false
  let inside = 0
  for (const p of pts) if (pointInPolygon(p, polygon)) inside++
  return inside / pts.length >= 0.5
}
