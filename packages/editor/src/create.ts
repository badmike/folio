/** Pure builders for objects created by dragging (shape & arrow tools). */
import type { ArrowObject, ObjectId, ShapeKind, ShapeObject, ShapeStyle, Vec2 } from '@folio/document'

/** Snap the vector a→b to the nearest multiple of 45 degrees. */
export function snapAngle(a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  const step = Math.PI / 4
  const ang = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len }
}

export interface ShapeGeometry {
  transform: ShapeObject['transform']
  width: number
  height: number
}

/**
 * Geometry for a shape dragged from `a` to `b`. `constrain` (shift) makes boxes
 * square and lines snap to 45 degrees. Lines are stored with the origin at the
 * start point and a possibly negative scale so the local diagonal (0,0)→(w,h)
 * points from start to end.
 */
export function shapeGeometry(kind: ShapeKind, a: Vec2, b: Vec2, constrain: boolean): ShapeGeometry {
  if (kind === 'line') {
    const e = constrain ? snapAngle(a, b) : b
    const dx = e.x - a.x
    const dy = e.y - a.y
    return {
      transform: { x: a.x, y: a.y, rotation: 0, scaleX: dx < 0 ? -1 : 1, scaleY: dy < 0 ? -1 : 1 },
      width: Math.abs(dx),
      height: Math.abs(dy),
    }
  }
  let dx = b.x - a.x
  let dy = b.y - a.y
  if (constrain) {
    const m = Math.max(Math.abs(dx), Math.abs(dy))
    dx = Math.sign(dx || 1) * m
    dy = Math.sign(dy || 1) * m
  }
  return {
    transform: { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), rotation: 0, scaleX: 1, scaleY: 1 },
    width: Math.abs(dx),
    height: Math.abs(dy),
  }
}

export function buildShape(
  id: ObjectId, kind: ShapeKind, geo: ShapeGeometry, style: ShapeStyle, z: number, now = Date.now(),
): ShapeObject {
  return { id, type: 'shape', kind, transform: geo.transform, width: geo.width, height: geo.height, style, z, createdAt: now, updatedAt: now }
}

export function buildArrow(
  id: ObjectId, start: Vec2, end: Vec2, o: {
    style: ShapeStyle; startHead: ArrowObject['startHead']; endHead: ArrowObject['endHead']
    startTarget?: ObjectId; endTarget?: ObjectId; z: number; now?: number
  },
): ArrowObject {
  const now = o.now ?? Date.now()
  const a: ArrowObject = {
    id, type: 'arrow', transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, z: o.z, createdAt: now, updatedAt: now,
    start, end, style: o.style, startHead: o.startHead, endHead: o.endHead,
  }
  if (o.startTarget) a.startBinding = { objectId: o.startTarget }
  if (o.endTarget) a.endBinding = { objectId: o.endTarget }
  return a
}
