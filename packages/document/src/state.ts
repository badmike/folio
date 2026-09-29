import { cloneJson, computePatch, compareObjects, type Patch } from './internal'
import type {
  CanvasObject, NotebookMeta, ObjectId, Operation, Page, PageId, Recognition,
} from './types'

/** Low-level mutations produced by the reducer; the notebook replays them into Loro. */
export type Mut =
  | { t: 'objPut'; pageId: PageId; obj: CanvasObject; prev?: CanvasObject }
  | { t: 'objPatch'; pageId: PageId; id: ObjectId; write: Patch; obj: CanvasObject }
  | { t: 'objDel'; pageId: PageId; id: ObjectId }
  | { t: 'pagePut'; page: Page; prev?: Page }
  | { t: 'pagePatch'; id: PageId; write: Patch; page: Page }
  | { t: 'pageDel'; id: PageId }
  | { t: 'recPut'; pageId: PageId; rec: Recognition }
  | { t: 'recDel'; pageId: PageId; id: string }
  | { t: 'metaPatch'; write: Patch }

/** Materialised notebook state (pure data; objects are treated as immutable values). */
export class DocState {
  meta: NotebookMeta
  pages = new Map<PageId, Page>()
  objects = new Map<PageId, Map<ObjectId, CanvasObject>>()
  recs = new Map<PageId, Map<string, Recognition>>()
  private cow = false
  private ownedObjs = new Set<PageId>()
  private ownedRecs = new Set<PageId>()

  constructor(meta: NotebookMeta) {
    this.meta = meta
  }

  /** Copy-on-write fork used by `inverse()` to simulate ops without touching real state. */
  fork(): DocState {
    const s = new DocState({ ...this.meta })
    s.pages = new Map(this.pages)
    s.objects = new Map(this.objects)
    s.recs = new Map(this.recs)
    s.cow = true
    return s
  }

  objMap(pageId: PageId, write = false): Map<ObjectId, CanvasObject> | undefined {
    let m = this.objects.get(pageId)
    if (write) {
      if (!m) this.objects.set(pageId, (m = new Map()))
      else if (this.cow && !this.ownedObjs.has(pageId)) this.objects.set(pageId, (m = new Map(m)))
      this.ownedObjs.add(pageId)
    }
    return m
  }

  recMap(pageId: PageId, write = false): Map<string, Recognition> | undefined {
    let m = this.recs.get(pageId)
    if (write) {
      if (!m) this.recs.set(pageId, (m = new Map()))
      else if (this.cow && !this.ownedRecs.has(pageId)) this.recs.set(pageId, (m = new Map(m)))
      this.ownedRecs.add(pageId)
    }
    return m
  }
}

export interface Effects {
  pageIds: Set<PageId>
  objectIds: Set<ObjectId>
  pagesChanged: boolean
  metaChanged: boolean
}

export function newEffects(): Effects {
  return { pageIds: new Set(), objectIds: new Set(), pagesChanged: false, metaChanged: false }
}

const OBJ_IGNORE = ['id', 'type', 'points']
const PAGE_IGNORE = ['id']
const META_IGNORE = ['id']

/**
 * Apply one operation to `state`, emitting low-level mutations to `emit` (if any),
 * recording effects and pushing the inverse operations (in execution order) to `inv`.
 */
export function reduceOp(
  state: DocState,
  op: Operation,
  emit: ((m: Mut) => void) | null,
  fx: Effects | null,
  inv: Operation[] | null,
): void {
  switch (op.type) {
    case 'addObjects': {
      const map = state.objMap(op.pageId, true)!
      const added: ObjectId[] = []
      const replaced: CanvasObject[] = []
      for (const o of op.objects) {
        const obj = cloneJson(o)
        const prev = map.get(obj.id)
        if (prev) replaced.push(prev)
        else added.push(obj.id)
        map.set(obj.id, obj)
        emit?.({ t: 'objPut', pageId: op.pageId, obj, prev })
        fx?.objectIds.add(obj.id)
      }
      fx?.pageIds.add(op.pageId)
      if (added.length) inv?.push({ type: 'deleteObjects', pageId: op.pageId, ids: added })
      if (replaced.length) inv?.push({ type: 'addObjects', pageId: op.pageId, objects: replaced })
      return
    }
    case 'deleteObjects': {
      const map = state.objMap(op.pageId)
      if (!map) return
      const removed: CanvasObject[] = []
      for (const id of op.ids) {
        const prev = map.get(id)
        if (!prev) continue
        removed.push(prev)
        fx?.objectIds.add(id)
        emit?.({ t: 'objDel', pageId: op.pageId, id })
      }
      if (!removed.length) return
      const w = state.objMap(op.pageId, true)!
      for (const o of removed) w.delete(o.id)
      fx?.pageIds.add(op.pageId)
      inv?.push({ type: 'addObjects', pageId: op.pageId, objects: removed })
      return
    }
    case 'updateObjects': {
      const invPatches: { id: ObjectId; patch: Record<string, unknown> }[] = []
      for (const { id, patch } of op.patches) {
        const prev = state.objMap(op.pageId)?.get(id)
        if (!prev) continue
        const r = computePatch(prev, patch, OBJ_IGNORE)
        if (!r) continue
        state.objMap(op.pageId, true)!.set(id, r.next)
        emit?.({ t: 'objPatch', pageId: op.pageId, id, write: r.write, obj: r.next })
        invPatches.push({ id, patch: r.inverse })
        fx?.objectIds.add(id)
        fx?.pageIds.add(op.pageId)
      }
      if (invPatches.length) {
        inv?.push({ type: 'updateObjects', pageId: op.pageId, patches: invPatches.reverse() as never })
      }
      return
    }
    case 'addPage': {
      const page = cloneJson(op.page)
      const prev = state.pages.get(page.id)
      state.pages.set(page.id, page)
      emit?.({ t: 'pagePut', page, prev })
      fx && ((fx.pagesChanged = true), fx.pageIds.add(page.id))
      inv?.push(prev ? { type: 'addPage', page: prev } : { type: 'deletePage', pageId: page.id })
      return
    }
    case 'updatePage': {
      const prev = state.pages.get(op.pageId)
      if (!prev) return
      const r = computePatch(prev, op.patch, PAGE_IGNORE)
      if (!r) return
      state.pages.set(op.pageId, r.next)
      emit?.({ t: 'pagePatch', id: op.pageId, write: r.write, page: r.next })
      fx && ((fx.pagesChanged = true), fx.pageIds.add(op.pageId))
      inv?.push({ type: 'updatePage', pageId: op.pageId, patch: r.inverse as never })
      return
    }
    case 'deletePage': {
      const prev = state.pages.get(op.pageId)
      const objs = [...(state.objMap(op.pageId)?.values() ?? [])]
      const recs = [...(state.recMap(op.pageId)?.values() ?? [])]
      if (!prev && !objs.length && !recs.length) return
      for (const o of objs) emit?.({ t: 'objDel', pageId: op.pageId, id: o.id })
      for (const r of recs) emit?.({ t: 'recDel', pageId: op.pageId, id: r.id })
      if (prev) emit?.({ t: 'pageDel', id: op.pageId })
      state.pages.delete(op.pageId)
      state.objects.delete(op.pageId)
      state.recs.delete(op.pageId)
      fx && ((fx.pagesChanged = true), fx.pageIds.add(op.pageId))
      if (prev) inv?.push({ type: 'addPage', page: prev })
      if (objs.length) inv?.push({ type: 'addObjects', pageId: op.pageId, objects: objs })
      if (recs.length) inv?.push({ type: 'setRecognitions', pageId: op.pageId, recognitions: recs })
      return
    }
    case 'setRecognitions': {
      const map = state.recMap(op.pageId, true)!
      const added: string[] = []
      const replaced: Recognition[] = []
      for (const r of op.recognitions) {
        const rec = cloneJson(r)
        const prev = map.get(rec.id)
        if (prev) replaced.push(prev)
        else added.push(rec.id)
        map.set(rec.id, rec)
        emit?.({ t: 'recPut', pageId: op.pageId, rec })
      }
      fx?.pageIds.add(op.pageId)
      if (added.length) inv?.push({ type: 'deleteRecognitions', pageId: op.pageId, ids: added })
      if (replaced.length) inv?.push({ type: 'setRecognitions', pageId: op.pageId, recognitions: replaced })
      return
    }
    case 'deleteRecognitions': {
      const existing = state.recMap(op.pageId)
      const removed = op.ids.map((id) => existing?.get(id)).filter((r): r is Recognition => !!r)
      if (!removed.length) return
      const map = state.recMap(op.pageId, true)!
      for (const r of removed) {
        map.delete(r.id)
        emit?.({ t: 'recDel', pageId: op.pageId, id: r.id })
      }
      fx?.pageIds.add(op.pageId)
      inv?.push({ type: 'setRecognitions', pageId: op.pageId, recognitions: removed })
      return
    }
    case 'updateMeta': {
      const r = computePatch(state.meta, op.patch, META_IGNORE)
      if (!r) return
      state.meta = r.next
      emit?.({ t: 'metaPatch', write: r.write })
      if (fx) fx.metaChanged = true
      inv?.push({ type: 'updateMeta', patch: r.inverse as never })
      return
    }
  }
}

/** Sorted pages: order, then createdAt, then id. */
export function sortPages(pages: Iterable<Page>): Page[] {
  return [...pages].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function sortObjects(objs: Iterable<CanvasObject>): CanvasObject[] {
  return [...objs].sort(compareObjects)
}
