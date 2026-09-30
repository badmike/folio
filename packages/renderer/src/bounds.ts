import type { ArrowObject, CanvasObject, InkStroke, ObjectId, Rect, Vec2 } from '@folio/document'
import { applyMat, boundsOfPoints, rectCorners, transformMatrix, unionRects } from './math'
import { measureText } from './text'
import { shapeOutline } from './shapes'
import { arrowPath, arrowTypeOf } from './arrows'

/** Flat stride of ink points (mirrors INK_POINT_STRIDE from @folio/document). */
export const STRIDE = 6

export type Resolve = (id: ObjectId) => CanvasObject | undefined

export function inkLocalPoints(s: InkStroke): Vec2[] {
  const out: Vec2[] = []
  const p = s.points
  for (let i = 0; i + 1 < p.length; i += STRIDE) out.push({ x: p[i], y: p[i + 1] })
  return out
}

/** Bounding box in LOCAL space (excluding stroke width), null for groups/arrows. */
export function localBounds(obj: CanvasObject): Rect | null {
  switch (obj.type) {
    case 'ink': return boundsOfPoints(inkLocalPoints(obj))
    case 'shape': return { x: 0, y: 0, width: obj.width, height: obj.height }
    case 'image': return { x: 0, y: 0, width: obj.width, height: obj.height }
    case 'text': {
      const m = measureText(obj)
      return { x: 0, y: 0, width: m.width, height: m.height }
    }
    default: return null
  }
}

/** Closed outline polygon in local space used for edge intersection & hit tests. */
export function localOutline(obj: CanvasObject): Vec2[] | null {
  if (obj.type === 'shape' && obj.kind !== 'line') return shapeOutline(obj.kind, obj.width, obj.height, { roundness: obj.style.roundness })
  const b = localBounds(obj)
  return b ? rectCorners(b) : null
}

/** Four world-space corners of the object's local bounds (oriented). */
export function worldCorners(obj: CanvasObject): Vec2[] | null {
  const b = localBounds(obj)
  if (!b) return null
  const m = transformMatrix(obj.transform)
  return rectCorners(b).map((p) => applyMat(m, p.x, p.y))
}

/** Axis-aligned world bounds (includes stroke width for ink/shapes/arrows). */
export function objectWorldBounds(obj: CanvasObject, resolve: Resolve, arrowEndpoints?: (a: ArrowObject) => { start: Vec2; end: Vec2 }): Rect | undefined {
  if (obj.type === 'arrow') {
    let pts: Vec2[]
    if (arrowEndpoints && arrowTypeOf(obj) === 'straight') {
      const ep = arrowEndpoints(obj)
      pts = [ep.start, ep.end]
    } else pts = arrowPath(obj, resolve)
    const pad = obj.style.strokeWidth / 2 + 8
    const b = boundsOfPoints(pts)
    return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
  }
  if (obj.type === 'group') {
    const rs: Rect[] = []
    for (const id of obj.childIds) {
      const c = resolve(id)
      if (c) {
        const r = objectWorldBounds(c, resolve, arrowEndpoints)
        if (r) rs.push(r)
      }
    }
    return unionRects(rs)
  }
  const corners = worldCorners(obj)
  if (!corners) return undefined
  const b = boundsOfPoints(corners)
  let pad = 0
  if (obj.type === 'ink') pad = obj.style.width * Math.max(Math.abs(obj.transform.scaleX), Math.abs(obj.transform.scaleY))
  else if (obj.type === 'shape') pad = obj.style.strokeWidth / 2 + 2
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
}
