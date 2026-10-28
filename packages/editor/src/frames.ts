/**
 * Frame membership: an object belongs to the topmost frame whose bounds fully contain it.
 * Pure, so the editor and the AI tools reconcile `frameId` the same way.
 */
import type { CanvasObject, ObjectId, ObjectPatch, ShapeObject } from '@folio/document'
import { rectContainsRect, worldBounds, type Resolve } from './geometry'
import { applyPatch, type ObjectPatchEntry } from './manipulate'

export const isFrame = (o: CanvasObject): o is ShapeObject => o.type === 'shape' && o.kind === 'frame'

/** Topmost frame whose bounds fully contain the object, if any. */
export function frameContaining(o: CanvasObject, frames: ShapeObject[], resolve: Resolve): ShapeObject | undefined {
  if (!frames.length || o.type === 'group') return undefined
  const b = worldBounds(o, resolve)
  if (!b) return undefined
  let best: ShapeObject | undefined
  for (const f of frames) {
    if (f.id === o.id) continue
    const fb = worldBounds(f, resolve)
    if (fb && rectContainsRect(fb, b) && (!best || f.z > best.z)) best = f
  }
  return best
}

/**
 * Membership patches for `objs` against `frames`: an object fully inside a frame joins it
 * (and is raised above it when needed), one outside every frame leaves its frame.
 */
export function frameMembershipPatches(objs: Iterable<CanvasObject>, frames: ShapeObject[], resolve: Resolve): ObjectPatchEntry[] {
  const out: ObjectPatchEntry[] = []
  const byId = new Set(frames.map((f) => f.id))
  for (const o of objs) {
    if (o.type === 'group' || o.supersededBy || isFrame(o)) continue
    const f = frameContaining(o, frames, resolve)
    if (f) {
      const patch: ObjectPatch = {}
      if (o.frameId !== f.id) patch.frameId = f.id
      if (o.z <= f.z) patch.z = f.z + 0.01
      if (Object.keys(patch).length) out.push({ id: o.id, patch })
    } else if (o.frameId && (byId.has(o.frameId) || !resolve(o.frameId))) {
      out.push({ id: o.id, patch: { $unset: ['frameId'] } })
    }
  }
  return out
}

/**
 * Geometry patches plus the membership changes they cause, merged per object: moved objects join
 * or leave frames, and a moved or resized frame re-checks every object on the page.
 */
export function withFrameMembership(entries: ObjectPatchEntry[], objects: Iterable<CanvasObject>, resolve: Resolve): ObjectPatchEntry[] {
  const all = new Map([...objects].map((o) => [o.id, o]))
  const patched = new Map<ObjectId, CanvasObject>()
  for (const e of entries) {
    const o = all.get(e.id)
    if (o) patched.set(e.id, applyPatch(o, e.patch))
  }
  const after = (id: ObjectId) => patched.get(id) ?? resolve(id)
  const frames = [...all.values()].filter((o) => isFrame(o) && !o.supersededBy).map((f) => after(f.id) ?? f).filter(isFrame)
  const movedFrame = [...patched.values()].some(isFrame)
  const candidates = movedFrame ? [...all.values()].map((o) => patched.get(o.id) ?? o) : patched.values()
  const merged = new Map(entries.map((e) => [e.id, e.patch]))
  for (const m of frameMembershipPatches(candidates, frames, after)) {
    const prev = merged.get(m.id)
    const $unset = [...(prev?.$unset ?? []), ...(m.patch.$unset ?? [])]
    merged.set(m.id, { ...prev, ...m.patch, ...($unset.length ? { $unset } : {}) })
  }
  return [...merged].map(([id, patch]) => ({ id, patch }))
}
