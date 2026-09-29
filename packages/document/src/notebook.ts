import { LoroDoc, LoroMap, VersionVector } from 'loro-crdt'
import type { NotebookDocumentApi } from './api'
import { createId, createPage } from './factories'
import { cloneJson, deepEqual, type Patch } from './internal'
import {
  DocState, newEffects, reduceOp, sortObjects, sortPages, type Effects, type Mut,
} from './state'
import type {
  CanvasObject, ChangeOrigin, DocChangeEvent, NotebookMeta, ObjectId, Operation, Page, PageId,
  Recognition, Unsubscribe,
} from './types'

export interface NotebookOptions {
  /** Loro peer id for this device (number, bigint or decimal string). Random when omitted. */
  peerId?: number | bigint | `${number}`
  now?: number
}

/**
 * Loro layout (flat keys avoid concurrent creation of nested containers):
 *   meta:         Map  field -> value
 *   pages:        Map  pageId -> Map(field -> value)
 *   objects:      Map  `${pageId}:${objectId}` -> Map(field -> value)   (one CRDT field per object field)
 *   recognitions: Map  `${pageId}:${recId}` -> plain Recognition value
 * Page ids must not contain ':'.
 */
export class NotebookDocument implements NotebookDocumentApi {
  readonly loro: LoroDoc
  private state: DocState
  private fallbackId: string
  private listeners = new Set<(e: DocChangeEvent) => void>()
  private sortedObjs = new Map<PageId, CanvasObject[]>()
  private sortedPages: Page[] | null = null

  private constructor(loro: LoroDoc, id: string) {
    this.loro = loro
    this.fallbackId = id
    this.state = new DocState(defaultMeta(id))
    this.rebuild()
  }

  // ---- constructors -------------------------------------------------------

  /** New notebook with a first infinite page. */
  static create(
    meta: Partial<NotebookMeta> & { title: string },
    opts: NotebookOptions = {},
  ): NotebookDocument {
    const now = opts.now ?? Date.now()
    const id = meta.id ?? createId()
    const doc = NotebookDocument.empty(id, opts)
    const full: NotebookMeta = {
      ...meta,
      id,
      title: meta.title,
      tags: meta.tags ?? [],
      createdAt: meta.createdAt ?? now,
      updatedAt: meta.updatedAt ?? now,
    }
    doc.apply([
      { type: 'updateMeta', patch: stripUndefined(full) as Partial<Omit<NotebookMeta, 'id'>> },
      { type: 'addPage', page: createPage({ kind: 'infinite', order: 1, now }) },
    ], 'local', { writeId: id })
    return doc
  }

  /** Empty document (nothing written); use it as the target of `importUpdates`. */
  static empty(id: string, opts: NotebookOptions = {}): NotebookDocument {
    return new NotebookDocument(newLoro(opts), id)
  }

  static fromSnapshot(bytes: Uint8Array, opts: NotebookOptions = {}): NotebookDocument {
    const loro = newLoro(opts)
    loro.import(bytes)
    return new NotebookDocument(loro, '')
  }

  /** Change the notebook id stored in the document (used when importing a copy). */
  rekey(newId: string): void {
    this.loro.getMap('meta').set('id', newId)
    this.loro.commit({ origin: 'local' })
    this.fallbackId = newId
    this.state.meta = { ...this.state.meta, id: newId }
    this.emit({ origin: 'local', pageIds: new Set(), pagesChanged: false, metaChanged: true })
  }

  // ---- reads --------------------------------------------------------------

  get id(): string {
    return this.state.meta.id
  }

  meta(): NotebookMeta {
    return cloneJson(this.state.meta)
  }

  pages(): Page[] {
    return (this.sortedPages ??= sortPages(this.state.pages.values()))
  }

  page(id: PageId): Page | undefined {
    return this.state.pages.get(id)
  }

  /** Sorted by z (stable, deterministic). The returned array is never mutated afterwards. */
  objects(pageId: PageId): CanvasObject[] {
    let arr = this.sortedObjs.get(pageId)
    if (!arr) {
      arr = sortObjects(this.state.objects.get(pageId)?.values() ?? [])
      this.sortedObjs.set(pageId, arr)
    }
    return arr
  }

  object(pageId: PageId, id: ObjectId): CanvasObject | undefined {
    return this.state.objects.get(pageId)?.get(id)
  }

  recognitions(pageId: PageId): Recognition[] {
    return [...(this.state.recs.get(pageId)?.values() ?? [])].sort((a, b) =>
      a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  }

  // ---- writes -------------------------------------------------------------

  apply(ops: Operation[], origin: 'local' | 'journal' = 'local', internal?: { writeId?: string }): void {
    if (ops.length === 0) return
    const fx = newEffects()
    const muts: Mut[] = []
    for (const op of ops) reduceOp(this.state, op, (m) => muts.push(m), fx, null)
    this.write(muts, internal?.writeId)
    this.loro.commit({ origin })
    this.invalidate(fx)
    this.emit({ origin, ...fx })
  }

  inverse(ops: Operation[]): Operation[] {
    const sim = this.state.fork()
    const groups: Operation[][] = []
    for (const op of ops) {
      const inv: Operation[] = []
      reduceOp(sim, op, null, null, inv)
      groups.push(inv)
    }
    return groups.reverse().flat()
  }

  subscribe(listener: (e: DocChangeEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ---- sync ---------------------------------------------------------------

  exportSnapshot(): Uint8Array {
    return this.loro.export({ mode: 'snapshot' })
  }

  exportUpdates(since?: Uint8Array): Uint8Array {
    if (!since) return this.loro.export({ mode: 'update' })
    return this.loro.export({ mode: 'update', from: VersionVector.decode(since) })
  }

  importUpdates(bytes: Uint8Array): void {
    this.loro.import(bytes)
    const before = this.state
    this.rebuild()
    const fx = diffStates(before, this.state)
    if (!fx) return
    this.invalidate(fx, true)
    this.emit({ origin: 'remote', ...fx })
  }

  version(): Uint8Array {
    return this.loro.oplogVersion().encode()
  }

  // ---- internals ----------------------------------------------------------

  private emit(e: Omit<DocChangeEvent, 'objectIds'> & { objectIds?: Set<ObjectId> }): void {
    for (const l of [...this.listeners]) l(e as DocChangeEvent)
  }

  private invalidate(fx: Effects, all = false): void {
    this.sortedPages = null
    if (all) this.sortedObjs.clear()
    for (const p of fx.pageIds) this.sortedObjs.delete(p)
  }

  /** Replay reducer mutations into the Loro containers. */
  private write(muts: Mut[], writeId?: string): void {
    const meta = this.loro.getMap('meta')
    const pages = this.loro.getMap('pages')
    const objects = this.loro.getMap('objects')
    const recs = this.loro.getMap('recognitions')
    if (writeId) meta.set('id', writeId)
    for (const m of muts) {
      switch (m.t) {
        case 'objPut': {
          const c = ensureMap(objects, key(m.pageId, m.obj.id))
          syncMap(c, m.obj as unknown as Record<string, unknown>, m.prev as unknown as Record<string, unknown> | undefined)
          break
        }
        case 'objPatch':
          patchMap(ensureMap(objects, key(m.pageId, m.id), m.obj as unknown as Record<string, unknown>), m.write)
          break
        case 'objDel':
          objects.delete(key(m.pageId, m.id))
          break
        case 'pagePut':
          syncMap(ensureMap(pages, m.page.id), m.page as unknown as Record<string, unknown>, m.prev as unknown as Record<string, unknown> | undefined)
          break
        case 'pagePatch':
          patchMap(ensureMap(pages, m.id, m.page as unknown as Record<string, unknown>), m.write)
          break
        case 'pageDel':
          pages.delete(m.id)
          break
        case 'recPut':
          recs.set(key(m.pageId, m.rec.id), m.rec as never)
          break
        case 'recDel':
          recs.delete(key(m.pageId, m.id))
          break
        case 'metaPatch':
          patchMap(meta, m.write)
          break
      }
    }
  }

  /** Rebuild the materialised state from the CRDT, preserving identity of unchanged values. */
  private rebuild(): void {
    const old = this.state
    const json = this.loro.toJSON() as {
      meta?: Record<string, unknown>
      pages?: Record<string, Page>
      objects?: Record<string, CanvasObject>
      recognitions?: Record<string, Recognition>
    }
    const m = json.meta ?? {}
    const id = typeof m.id === 'string' ? m.id : this.fallbackId
    const next = new DocState({ ...defaultMeta(id), ...(m as object) } as NotebookMeta)
    if (deepEqual(old.meta, next.meta)) next.meta = old.meta
    for (const [pid, p] of Object.entries(json.pages ?? {})) {
      if (!p || typeof p !== 'object') continue
      const page = { ...p, id: pid }
      const prev = old.pages.get(pid)
      next.pages.set(pid, prev && deepEqual(prev, page) ? prev : page)
    }
    for (const [k, o] of Object.entries(json.objects ?? {})) {
      const i = k.indexOf(':')
      if (i < 0 || !o || typeof o !== 'object' || !(o as CanvasObject).type) continue
      const pid = k.slice(0, i)
      const oid = k.slice(i + 1)
      const obj = { ...o, id: oid } as CanvasObject
      let map = next.objects.get(pid)
      if (!map) next.objects.set(pid, (map = new Map()))
      const prev = old.objects.get(pid)?.get(oid)
      map.set(oid, prev && deepEqual(prev, obj) ? prev : obj)
    }
    for (const [k, r] of Object.entries(json.recognitions ?? {})) {
      const i = k.indexOf(':')
      if (i < 0 || !r || typeof r !== 'object') continue
      const pid = k.slice(0, i)
      let map = next.recs.get(pid)
      if (!map) next.recs.set(pid, (map = new Map()))
      const prev = old.recs.get(pid)?.get(r.id)
      map.set(r.id, prev && deepEqual(prev, r) ? prev : r)
    }
    this.state = next
  }
}

// ---------------------------------------------------------------------------

function defaultMeta(id: string): NotebookMeta {
  return { id, title: '', tags: [], createdAt: 0, updatedAt: 0 }
}

function newLoro(opts: NotebookOptions): LoroDoc {
  const d = new LoroDoc()
  if (opts.peerId !== undefined) d.setPeerId(opts.peerId as never)
  return d
}

const key = (pageId: string, id: string) => `${pageId}:${id}`

function stripUndefined<T extends object>(o: T): T {
  return cloneJson(o)
}

function ensureMap(parent: LoroMap, k: string, fill?: Record<string, unknown>): LoroMap {
  const existing = parent.get(k)
  if (existing instanceof LoroMap) return existing
  const c = parent.setContainer(k, new LoroMap())
  if (fill) for (const [f, v] of Object.entries(fill)) if (v !== undefined) c.set(f, v as never)
  return c
}

/** Make `c` equal `next`: set the fields that differ from `prev` (all when no prev), delete removed ones. */
function syncMap(c: LoroMap, next: Record<string, unknown>, prev?: Record<string, unknown>): void {
  for (const [f, v] of Object.entries(next)) {
    if (v === undefined) continue
    if (prev && f in prev && deepEqual(prev[f], v)) continue
    c.set(f, v as never)
  }
  if (prev) for (const f of Object.keys(prev)) if (!(f in next) || next[f] === undefined) c.delete(f)
}

function patchMap(c: LoroMap, w: Patch): void {
  for (const [f, v] of Object.entries(w.set)) c.set(f, v as never)
  for (const f of w.unset) c.delete(f)
}

/** Effects describing what differs between two states, or null when identical (by identity). */
function diffStates(a: DocState, b: DocState): Effects | null {
  const fx = newEffects()
  if (a.meta !== b.meta) fx.metaChanged = true
  const pageIds = new Set([...a.pages.keys(), ...b.pages.keys()])
  for (const id of pageIds) {
    if (a.pages.get(id) !== b.pages.get(id)) {
      fx.pagesChanged = true
      fx.pageIds.add(id)
    }
  }
  const allPages = new Set([...a.objects.keys(), ...b.objects.keys(), ...a.recs.keys(), ...b.recs.keys()])
  for (const pid of allPages) {
    const oa = a.objects.get(pid), ob = b.objects.get(pid)
    for (const id of new Set([...(oa?.keys() ?? []), ...(ob?.keys() ?? [])])) {
      if (oa?.get(id) !== ob?.get(id)) {
        fx.pageIds.add(pid)
        fx.objectIds.add(id)
      }
    }
    const ra = a.recs.get(pid), rb = b.recs.get(pid)
    for (const id of new Set([...(ra?.keys() ?? []), ...(rb?.keys() ?? [])])) {
      if (ra?.get(id) !== rb?.get(id)) fx.pageIds.add(pid)
    }
  }
  if (!fx.metaChanged && !fx.pagesChanged && fx.pageIds.size === 0) return null
  return fx
}

export type { ChangeOrigin }
