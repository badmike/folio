/**
 * Pure functions computing object patches for move / scale / rotate, cloning
 * for duplicate & paste, and patch application (used for live previews).
 */
import type {
  ArrowObject, CanvasObject, ObjectId, ObjectPatch, Rect, TextObject, Transform, Vec2,
} from '@folio/document'
import {
  createId, estimateTextSize, localBounds, localToWorld, resolveArrowEndpoints, rotateAround, unionRects, worldBounds,
} from './geometry'
import type { Resolve } from './geometry'

export interface ObjectPatchEntry {
  id: ObjectId
  patch: ObjectPatch
}

/** Apply a patch to a copy of an object (handles $unset). */
export function applyPatch<T extends CanvasObject>(obj: T, patch: ObjectPatch): T {
  const { $unset, ...rest } = patch
  const next = { ...obj, ...rest } as Record<string, unknown>
  if ($unset) for (const k of $unset) delete next[k]
  return next as unknown as T
}

// -- selection frame ------------------------------------------------------------

/** Oriented selection frame: `rect` is unrotated; rotate by `rotation` about its center. */
export interface SelectionFrame {
  rect: Rect
  rotation: number
  center: Vec2
}

export function computeFrame(leaves: CanvasObject[], resolve: Resolve): SelectionFrame | undefined {
  if (!leaves.length) return undefined
  if (leaves.length === 1 && leaves[0].type !== 'arrow' && leaves[0].type !== 'group') {
    const o = leaves[0]
    const lb = localBounds(o)
    if (lb) {
      const center = localToWorld(o.transform, { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 })
      const w = lb.width * Math.abs(o.transform.scaleX)
      const h = lb.height * Math.abs(o.transform.scaleY)
      return { rect: { x: center.x - w / 2, y: center.y - h / 2, width: w, height: h }, rotation: o.transform.rotation, center }
    }
  }
  const rects: Rect[] = []
  for (const o of leaves) {
    const b = worldBounds(o, resolve)
    if (b) rects.push(b)
  }
  const u = unionRects(rects)
  if (!u) return undefined
  return { rect: u, rotation: 0, center: { x: u.x + u.width / 2, y: u.y + u.height / 2 } }
}

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLE_IDS: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const HANDLE_DIR: Record<HandleId, Vec2> = {
  nw: { x: -1, y: -1 }, n: { x: 0, y: -1 }, ne: { x: 1, y: -1 }, e: { x: 1, y: 0 },
  se: { x: 1, y: 1 }, s: { x: 0, y: 1 }, sw: { x: -1, y: 1 }, w: { x: -1, y: 0 },
}

/** World position of a handle of the frame. */
export function handlePosition(frame: SelectionFrame, h: HandleId): Vec2 {
  const d = HANDLE_DIR[h]
  return rotateAround(
    { x: frame.center.x + (d.x * frame.rect.width) / 2, y: frame.center.y + (d.y * frame.rect.height) / 2 },
    frame.center, frame.rotation,
  )
}

/** World position of the rotation handle, `offset` world units above the top edge. */
export function rotationHandlePosition(frame: SelectionFrame, offset: number): Vec2 {
  return rotateAround({ x: frame.center.x, y: frame.center.y - frame.rect.height / 2 - offset }, frame.center, frame.rotation)
}

export interface ScaleSpec {
  /** World point that stays fixed. */
  anchor: Vec2
  /** Frame rotation (axes in which sx/sy apply). */
  theta: number
  sx: number
  sy: number
}

/** Scale factors for dragging `handle` of `frame` to world point `p`. */
export function scaleFromHandle(frame: SelectionFrame, handle: HandleId, p: Vec2, keepAspect: boolean): ScaleSpec {
  const dir = HANDLE_DIR[handle]
  const w = Math.max(frame.rect.width, 1e-6)
  const h = Math.max(frame.rect.height, 1e-6)
  const q = rotateAround(p, frame.center, -frame.rotation)
  const rx = q.x - frame.center.x
  const ry = q.y - frame.center.y
  const minF = 0.02
  let sx = 1
  let sy = 1
  // anchor is the opposite edge/corner; along an axis with dir 0 nothing scales
  if (dir.x !== 0) sx = Math.max(minF, ((rx + (dir.x * w) / 2) * dir.x) / w)
  if (dir.y !== 0) sy = Math.max(minF, ((ry + (dir.y * h) / 2) * dir.y) / h)
  if (keepAspect && dir.x !== 0 && dir.y !== 0) {
    const s = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy
    sx = s
    sy = s
  } else if (keepAspect) {
    if (dir.x === 0) sx = sy
    else sy = sx
  }
  const anchorFrame = { x: frame.center.x - (dir.x * w) / 2, y: frame.center.y - (dir.y * h) / 2 }
  return { anchor: rotateAround(anchorFrame, frame.center, frame.rotation), theta: frame.rotation, sx, sy }
}

// -- patches ---------------------------------------------------------------------

const stamp = (now: number): Partial<ObjectPatch> => ({ updatedAt: now })

/** Patch for an arrow after its stored coordinates were transformed; drops bindings to unselected targets. */
function arrowPatch(a: ArrowObject, start: Vec2, end: Vec2, selected: Set<ObjectId>, now: number): ObjectPatch {
  const patch: ObjectPatch = { start, end, ...stamp(now) }
  const unset: string[] = []
  if (a.startBinding && !selected.has(a.startBinding.objectId)) unset.push('startBinding')
  if (a.endBinding && !selected.has(a.endBinding.objectId)) unset.push('endBinding')
  if (unset.length) patch.$unset = unset
  return patch
}

/** Effective (start,end) of an arrow, following bindings. */
function arrowEnds(a: ArrowObject, resolve: Resolve): { start: Vec2; end: Vec2 } {
  return resolveArrowEndpoints(a, resolve)
}

export function computeMovePatches(leaves: CanvasObject[], dx: number, dy: number, resolve: Resolve, now = Date.now()): ObjectPatchEntry[] {
  const selected = new Set(leaves.map((l) => l.id))
  return leaves.map((o) => {
    if (o.type === 'arrow') {
      const { start, end } = arrowEnds(o, resolve)
      return {
        id: o.id,
        patch: arrowPatch(o, { x: start.x + dx, y: start.y + dy }, { x: end.x + dx, y: end.y + dy }, selected, now),
      }
    }
    const t: Transform = { ...o.transform, x: o.transform.x + dx, y: o.transform.y + dy }
    return { id: o.id, patch: { transform: t, ...stamp(now) } }
  })
}

export function computeRotatePatches(
  leaves: CanvasObject[], center: Vec2, delta: number, resolve: Resolve, now = Date.now(),
): ObjectPatchEntry[] {
  const selected = new Set(leaves.map((l) => l.id))
  return leaves.map((o) => {
    if (o.type === 'arrow') {
      const { start, end } = arrowEnds(o, resolve)
      return { id: o.id, patch: arrowPatch(o, rotateAround(start, center, delta), rotateAround(end, center, delta), selected, now) }
    }
    const p = rotateAround({ x: o.transform.x, y: o.transform.y }, center, delta)
    const t: Transform = { ...o.transform, x: p.x, y: p.y, rotation: o.transform.rotation + delta }
    return { id: o.id, patch: { transform: t, ...stamp(now) } }
  })
}

function angleDiff(a: number): number {
  let d = a % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}

export function computeScalePatches(leaves: CanvasObject[], spec: ScaleSpec, resolve: Resolve, now = Date.now()): ObjectPatchEntry[] {
  const { anchor, theta, sx, sy } = spec
  const selected = new Set(leaves.map((l) => l.id))
  const mapPoint = (p: Vec2): Vec2 => {
    const q = rotateAround(p, anchor, -theta)
    const s = { x: anchor.x + (q.x - anchor.x) * sx, y: anchor.y + (q.y - anchor.y) * sy }
    return rotateAround(s, anchor, theta)
  }
  return leaves.map((o) => {
    if (o.type === 'arrow') {
      const { start, end } = arrowEnds(o, resolve)
      return { id: o.id, patch: arrowPatch(o, mapPoint(start), mapPoint(end), selected, now) }
    }
    // factors in the object's own axes
    const d = Math.abs(angleDiff(o.transform.rotation - theta))
    let fx = sx
    let fy = sy
    if (Math.abs(d - Math.PI / 2) < 0.01) {
      fx = sy
      fy = sx
    } else if (d > 0.01 && Math.abs(d - Math.PI) > 0.01) {
      fx = fy = Math.sqrt(sx * sy)
    }
    const p = mapPoint({ x: o.transform.x, y: o.transform.y })
    const t: Transform = { ...o.transform, x: p.x, y: p.y }
    const patch: ObjectPatch = { ...stamp(now) }
    if (o.type === 'shape') {
      patch.width = o.width * fx
      patch.height = o.height * fy
    } else if (o.type === 'text') {
      if (fy === 1 && fx !== 1) {
        patch.width = (o.width ?? estimateTextSize(o).width) * fx
      } else {
        const f = Math.sqrt(fx * fy)
        patch.fontSize = o.fontSize * f
        if (o.width !== undefined) patch.width = o.width * f
      }
    } else {
      t.scaleX = o.transform.scaleX * fx
      t.scaleY = o.transform.scaleY * fy
    }
    patch.transform = t
    return { id: o.id, patch }
  })
}

// -- cloning (duplicate / paste) -----------------------------------------------------

export interface CloneResult {
  objects: CanvasObject[]
  idMap: Map<ObjectId, ObjectId>
}

/**
 * Deep-clone objects with fresh ids, translated by (dx,dy), stacked above `baseZ`.
 * Internal references (arrow bindings, groupId, group childIds) are remapped;
 * references to objects outside the set are dropped.
 */
export function cloneObjects(objects: CanvasObject[], dx: number, dy: number, baseZ: number, now = Date.now()): CloneResult {
  const idMap = new Map<ObjectId, ObjectId>()
  for (const o of objects) idMap.set(o.id, createId())
  const sorted = [...objects].sort((a, b) => a.z - b.z)
  const out: CanvasObject[] = sorted.map((src, i) => {
    const o = JSON.parse(JSON.stringify(src)) as CanvasObject
    o.id = idMap.get(src.id)!
    o.z = baseZ + i + 1
    o.createdAt = now
    o.updatedAt = now
    delete o.supersededBy
    if (o.groupId) {
      const g = idMap.get(o.groupId)
      if (g) o.groupId = g
      else delete o.groupId
    }
    if (o.type === 'group') o.childIds = o.childIds.filter((c) => idMap.has(c)).map((c) => idMap.get(c)!)
    else if (o.type === 'arrow') {
      o.start = { x: o.start.x + dx, y: o.start.y + dy }
      o.end = { x: o.end.x + dx, y: o.end.y + dy }
      for (const key of ['startBinding', 'endBinding'] as const) {
        const b = o[key]
        if (!b) continue
        const target = idMap.get(b.objectId)
        if (target) o[key] = { ...b, objectId: target }
        else delete o[key]
      }
      delete o.sourceStrokeIds
    } else {
      o.transform = { ...o.transform, x: o.transform.x + dx, y: o.transform.y + dy }
      if (o.type === 'text' || o.type === 'shape') delete (o as TextObject).sourceStrokeIds
    }
    return o
  })
  return { objects: out, idMap }
}
