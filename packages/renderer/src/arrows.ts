import type { ArrowBinding, ArrowObject, CanvasObject, ObjectId, Rect, ShapeObject, Vec2 } from '@folio/document'
import type { ArrowGeometry, ResolveArrow } from './contract'
import { applyMat, boundsOfPoints, invert, pointInPolygon, segmentIntersection, transformMatrix } from './math'
import { localBounds, localOutline, worldCorners } from './bounds'
import { catmullRom, orthogonalRoute, simplifyOrthogonal } from './geometry/curves'

type Resolve = (id: ObjectId) => CanvasObject | undefined

/** Length (world units) of the perpendicular stub an elbow arrow leaves a bound shape with. */
export const ELBOW_GAP = 16

interface Anchor {
  /** Attach point in world space (anchor within target bounds). */
  world: Vec2
  target: CanvasObject
}

function resolveAnchor(binding: ArrowBinding | undefined, resolve: Resolve): Anchor | null {
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

const sameXY = (a: Vec2, b: Vec2): boolean => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9

export function arrowTypeOf(a: ArrowObject): 'straight' | 'curved' | 'elbow' {
  return a.arrowType ?? 'straight'
}

// ---------------------------------------------------------------------------
// Elbow routing
// ---------------------------------------------------------------------------

interface Side { dir: Vec2 }
const SIDES: Vec2[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]

/** Which side of `bounds` faces the reference point (outward unit normal). */
function facingSide(bounds: Rect, ref: Vec2): Side {
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  const dx = (ref.x - cx) / Math.max(bounds.width / 2, 1e-6)
  const dy = (ref.y - cy) / Math.max(bounds.height / 2, 1e-6)
  if (Math.abs(dx) >= Math.abs(dy)) return { dir: dx >= 0 ? SIDES[0] : SIDES[1] }
  return { dir: dy >= 0 ? SIDES[2] : SIDES[3] }
}

function dominantAxis(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x, dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? SIDES[0] : SIDES[1]
  return dy >= 0 ? SIDES[2] : SIDES[3]
}

function worldAABB(t: CanvasObject): Rect | null {
  const c = worldCorners(t)
  return c ? boundsOfPoints(c) : null
}

interface Exit {
  /** Point on the shape outline. */
  edge: Vec2
  /** Outward unit direction. */
  dir: Vec2
  /** Start of the free route (edge pushed out by the gap when bound). */
  stub: Vec2
}

function exitFor(anchor: Anchor | null, free: Vec2, ref: Vec2): Exit {
  if (!anchor) {
    const dir = dominantAxis(free, ref)
    return { edge: free, dir, stub: free }
  }
  const bounds = worldAABB(anchor.target)
  if (!bounds) return { edge: anchor.world, dir: dominantAxis(anchor.world, ref), stub: anchor.world }
  const { dir } = facingSide(bounds, ref)
  const far = { x: anchor.world.x + dir.x * 1e6, y: anchor.world.y + dir.y * 1e6 }
  const edge = edgePoint(anchor, far)
  return { edge, dir, stub: { x: edge.x + dir.x * ELBOW_GAP, y: edge.y + dir.y * ELBOW_GAP } }
}

/**
 * Orthogonal route (all segments horizontal/vertical) between the resolved ends.
 * Bound ends leave/enter their shape perpendicular to the side facing the other
 * end (or the nearest waypoint) with a short stub; waypoints are fixed corners.
 */
function elbowPath(arrow: ArrowObject, resolve: Resolve): Vec2[] {
  const wps = arrow.waypoints ?? []
  const sa = resolveAnchor(arrow.startBinding, resolve)
  const ea = resolveAnchor(arrow.endBinding, resolve)
  const refS = wps.length ? wps[0] : ea ? ea.world : arrow.end
  const refE = wps.length ? wps[wps.length - 1] : sa ? sa.world : arrow.start
  const s = exitFor(sa, arrow.start, refS)
  const e = exitFor(ea, arrow.end, refE)
  const mids = [s.stub, ...wps, e.stub]
  const route: Vec2[] = [mids[0]]
  let prevAxis: 'h' | 'v' | undefined
  for (let i = 0; i + 1 < mids.length; i++) {
    const first = i === 0
    const last = i + 2 === mids.length
    const leg = orthogonalRoute(mids[i], first ? s.dir : null, mids[i + 1], last ? e.dir : null, {
      firstAxis: first ? undefined : prevAxis === 'h' ? 'v' : prevAxis === 'v' ? 'h' : undefined,
    })
    for (let k = 1; k < leg.length; k++) route.push(leg[k])
    if (leg.length >= 2) {
      const a = leg[leg.length - 2], b = leg[leg.length - 1]
      prevAxis = Math.abs(a.y - b.y) < 1e-6 ? 'h' : 'v'
    }
  }
  const pts: Vec2[] = []
  if (!sameXY(s.edge, s.stub)) pts.push(s.edge)
  pts.push(...route)
  if (!sameXY(e.edge, e.stub)) pts.push(e.edge)
  // keep the exact free endpoints when unbound (no stub)
  return simplifyOrthogonal(pts)
}

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an arrow's world endpoints. Unbound ends use arrow.start/end; bound ends
 * attach at the intersection of the target outline with the line towards the
 * other end. Curved arrows aim towards the first/last waypoint instead of the
 * other end; elbow arrows use the ends of their orthogonal route.
 */
export const resolveArrowEndpoints: ResolveArrow = (arrow: ArrowObject, resolve): ArrowGeometry => {
  const type = arrowTypeOf(arrow)
  if (type === 'elbow') {
    const p = elbowPath(arrow, resolve)
    if (p.length >= 2) return { start: { ...p[0] }, end: { ...p[p.length - 1] } }
  }
  const sa = resolveAnchor(arrow.startBinding, resolve)
  const ea = resolveAnchor(arrow.endBinding, resolve)
  const wps = type === 'curved' ? arrow.waypoints ?? [] : []
  const otherOfStart: Vec2 = wps.length ? wps[0] : ea ? ea.world : arrow.end
  const otherOfEnd: Vec2 = wps.length ? wps[wps.length - 1] : sa ? sa.world : arrow.start
  const start = sa ? edgePoint(sa, otherOfStart) : arrow.start
  const end = ea ? edgePoint(ea, otherOfEnd) : arrow.end
  return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } }
}

// ---------------------------------------------------------------------------
// Path & handles
// ---------------------------------------------------------------------------

/**
 * Flattened WORLD polyline of an arrow (resolved endpoints included): a straight
 * segment, a smooth centripetal Catmull-Rom curve through the waypoints, or an
 * orthogonal elbow route. Used for rendering, hit testing and bounds.
 */
export function arrowPath(arrow: ArrowObject, resolve: Resolve): Vec2[] {
  const type = arrowTypeOf(arrow)
  if (type === 'elbow') {
    const p = elbowPath(arrow, resolve)
    if (p.length >= 2) return p
  }
  const { start, end } = resolveArrowEndpoints(arrow, resolve)
  if (type === 'curved' && arrow.waypoints?.length) return catmullRom([start, ...arrow.waypoints, end]).path
  return [start, end]
}

export interface ArrowHandleSpec {
  id: string
  world: Vec2
  kind: 'end' | 'waypoint' | 'virtual'
}
/** Same handle shape for subdivided lines (ShapeObject kind 'line'). */
export type PathHandleSpec = ArrowHandleSpec

/** Point halfway (by arc length) along path[from..to]. */
function halfwayPoint(path: Vec2[], from: number, to: number): Vec2 {
  let total = 0
  for (let i = from + 1; i <= to; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
  let acc = 0
  for (let i = from + 1; i <= to; i++) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
    if (d > 0 && acc + d >= total / 2) {
      const t = (total / 2 - acc) / d
      return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t }
    }
    acc += d
  }
  return { ...path[from] }
}

/**
 * Editing handles of a single selected arrow: 'start' / 'end'; for curved arrows
 * `wp:<i>` per waypoint and `v:<i>` (on the curve, halfway between control
 * points i and i+1); for elbow arrows `v:<i>` at the middle of route segment i
 * (only segments that are not the first/last stub-to-endpoint one).
 */
export function arrowHandleSpecs(arrow: ArrowObject, resolve: Resolve): ArrowHandleSpec[] {
  const type = arrowTypeOf(arrow)
  const { start, end } = resolveArrowEndpoints(arrow, resolve)
  const out: ArrowHandleSpec[] = [
    { id: 'start', world: start, kind: 'end' },
    { id: 'end', world: end, kind: 'end' },
  ]
  if (type === 'curved') {
    const wps = arrow.waypoints ?? []
    const curve = catmullRom([start, ...wps, end])
    wps.forEach((w, i) => out.push({ id: `wp:${i}`, world: { ...w }, kind: 'waypoint' }))
    for (let i = 0; i + 1 < curve.controlIndex.length; i++) {
      out.push({ id: `v:${i}`, world: halfwayPoint(curve.path, curve.controlIndex[i], curve.controlIndex[i + 1]), kind: 'virtual' })
    }
  } else if (type === 'elbow') {
    // every segment gets a handle; dragging an end segment splits it (see elbowWaypointsAfterDrag)
    const p = elbowPath(arrow, resolve)
    for (let i = 0; i + 1 < p.length; i++) {
      if (Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y) < 12) continue
      out.push({ id: `v:${i}`, world: { x: (p[i].x + p[i + 1].x) / 2, y: (p[i].y + p[i + 1].y) / 2 }, kind: 'virtual' })
    }
  }
  return out
}

/**
 * New waypoints after dragging elbow route segment `seg` (between route points
 * seg and seg+1) to `to`, perpendicular to the segment. `path` is the current
 * arrowPath(); the interior corners become the waypoints. The first and last
 * segment keep their end point fixed, so dragging them subdivides the route:
 * the end stays, a short perpendicular leg joins the moved segment.
 */
export function elbowWaypointsAfterDrag(path: Vec2[], seg: number, to: Vec2): Vec2[] {
  const pts = path.map((p) => ({ ...p }))
  const a = pts[seg], b = pts[seg + 1]
  if (!a || !b) return pts.slice(1, -1)
  const horizontal = Math.abs(a.y - b.y) < 1e-6
  const moved = (p: Vec2): Vec2 => (horizontal ? { x: p.x, y: to.y } : { x: to.x, y: p.y })
  const first = seg === 0
  const last = seg + 2 === pts.length
  const out: Vec2[] = [...pts.slice(0, seg)]
  if (first) out.push(a, moved(a)); else out.push(moved(a))
  if (last) out.push(moved(b), b); else out.push(moved(b))
  out.push(...pts.slice(seg + 2))
  return simplifyOrthogonal(out).slice(1, -1)
}

// ---------------------------------------------------------------------------
// Subdivided lines (ShapeObject kind 'line' with local `points`)
// ---------------------------------------------------------------------------

/** Local polyline of a line shape (its diagonal when not subdivided). */
export function linePoints(s: ShapeObject): Vec2[] {
  return s.points && s.points.length >= 2 ? s.points : [{ x: 0, y: 0 }, { x: s.width, y: s.height }]
}

/** Editing handles of a single selected line: 'start' / 'end', `wp:<i>` per interior point, `v:<i>` per segment middle. */
export function lineHandleSpecs(s: ShapeObject): PathHandleSpec[] {
  const m = transformMatrix(s.transform)
  const pts = linePoints(s).map((p) => applyMat(m, p.x, p.y))
  const out: PathHandleSpec[] = [
    { id: 'start', world: pts[0], kind: 'end' },
    { id: 'end', world: pts[pts.length - 1], kind: 'end' },
  ]
  for (let i = 1; i + 1 < pts.length; i++) out.push({ id: `wp:${i}`, world: pts[i], kind: 'waypoint' })
  for (let i = 0; i + 1 < pts.length; i++) {
    out.push({ id: `v:${i}`, world: { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }, kind: 'virtual' })
  }
  return out
}

/**
 * Geometry patch for a line after one of its points moved (or a segment middle was
 * dragged, which inserts a point). `index` is the point index (0 = start), `insertAfter`
 * the segment index for a new point. The result is normalised: points start at (0,0)
 * in a unit-scale, unrotated-by-drag box, width/height is the bounding box.
 */
export function linePointsAfterDrag(
  s: ShapeObject, edit: { index: number } | { insertAfter: number } | { remove: number }, world?: Vec2,
): Pick<ShapeObject, 'points' | 'width' | 'height' | 'transform'> {
  const m = transformMatrix(s.transform)
  const inv = invert(m)
  const pts = linePoints(s).map((p) => applyMat(m, p.x, p.y))
  if ('remove' in edit) {
    if (pts.length > 2) pts.splice(edit.remove, 1)
  } else if (world) {
    if ('index' in edit) pts[edit.index] = world
    else pts.splice(edit.insertAfter + 1, 0, world)
  }
  // keep the rotation, drop mirroring scales: express points in a unit-scale local frame
  const rot = s.transform.rotation
  const c = Math.cos(-rot), sn = Math.sin(-rot)
  const local = pts.map((p) => ({ x: p.x * c - p.y * sn, y: p.x * sn + p.y * c }))
  const b = boundsOfPoints(local)
  const points = local.map((p) => ({ x: p.x - b.x, y: p.y - b.y }))
  const cr = Math.cos(rot), sr = Math.sin(rot)
  void inv
  return {
    points,
    width: b.width,
    height: b.height,
    transform: { x: b.x * cr - b.y * sr, y: b.x * sr + b.y * cr, rotation: rot, scaleX: 1, scaleY: 1 },
  }
}
