import type { ArrowBinding, ArrowObject, CanvasObject, ObjectId, Vec2 } from '@folio/document'
import type { ArrowGeometry, ResolveArrow } from './contract'
import { applyMat, invert, pointInPolygon, segmentIntersection, transformMatrix } from './math'
import { localBounds, localOutline } from './bounds'

interface Anchor {
  /** Attach point in world space (anchor within target bounds). */
  world: Vec2
  target: CanvasObject
}

function resolveAnchor(binding: ArrowBinding | undefined, resolve: (id: ObjectId) => CanvasObject | undefined): Anchor | null {
  if (!binding) return null
  const target = resolve(binding.objectId)
  if (!target || target.type === 'arrow' || target.type === 'group') return null
  const b = localBounds(target)
  if (!b) return null
  const a = binding.anchor ?? { x: 0.5, y: 0.5 }
  const m = transformMatrix(target.transform)
  return { world: applyMat(m, b.x + a.x * b.width, b.y + a.y * b.height), target }
}

/** Point where the segment from the anchor towards `toward` leaves the target's outline (world space). */
function edgePoint(anchor: Anchor, toward: Vec2): Vec2 {
  const outline = localOutline(anchor.target)
  const m = transformMatrix(anchor.target.transform)
  const inv = invert(m)
  if (!outline || !inv) return anchor.world
  const poly = outline.map((p) => applyMat(m, p.x, p.y))
  const c = anchor.world
  if (!pointInPolygon(c, poly)) return c
  let best = -1
  for (let i = 0; i < poly.length; i++) {
    const t = segmentIntersection(c, toward, poly[i], poly[(i + 1) % poly.length])
    if (t !== null && t > best) best = t
  }
  if (best < 0) return c // other end lies inside the shape
  return { x: c.x + (toward.x - c.x) * best, y: c.y + (toward.y - c.y) * best }
}

/**
 * Resolve an arrow's world endpoints. Unbound ends use arrow.start/end; bound ends
 * attach at the intersection of the target outline with the line towards the other end.
 */
export const resolveArrowEndpoints: ResolveArrow = (arrow: ArrowObject, resolve): ArrowGeometry => {
  const sa = resolveAnchor(arrow.startBinding, resolve)
  const ea = resolveAnchor(arrow.endBinding, resolve)
  const otherOfStart: Vec2 = ea ? ea.world : arrow.end
  const otherOfEnd: Vec2 = sa ? sa.world : arrow.start
  const start = sa ? edgePoint(sa, otherOfStart) : arrow.start
  const end = ea ? edgePoint(ea, otherOfEnd) : arrow.end
  return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } }
}
