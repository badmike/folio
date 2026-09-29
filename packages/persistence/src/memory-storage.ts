import type { NotebookId, Operation } from '@folio/document'
import type { SearchDoc, SearchHit, Storage, StoredDoc, SyncState } from './contract'
import { searchDocs } from './text'

/** Backing state of a MemoryStorage; share one between instances to simulate a restart. */
export interface MemoryState {
  docs: Map<string, { snapshot: Uint8Array; snapshotSeq: number }>
  ops: { seq: number; docId: string; ops: string }[]
  nextSeq: number
  search: SearchDoc[]
  assets: Map<string, { bytes: Uint8Array; mimeType: string }>
  thumbs: Map<string, string>
  sync: Map<string, SyncState>
  settings: Map<string, string>
}

export function createMemoryState(): MemoryState {
  return {
    docs: new Map(), ops: [], nextSeq: 1, search: [], assets: new Map(),
    thumbs: new Map(), sync: new Map(), settings: new Map(),
  }
}

const copy = (u: Uint8Array | null): Uint8Array | null => (u ? new Uint8Array(u) : null)

/** In-memory storage for tests and as a last resort (nothing survives a reload). */
export class MemoryStorage implements Storage {
  readonly kind = 'memory' as const
  constructor(private readonly s: MemoryState = createMemoryState()) {}

  async init() {}

  async loadDoc(docId: string): Promise<StoredDoc> {
    const d = this.s.docs.get(docId)
    const snapshotSeq = d?.snapshotSeq ?? 0
    return {
      snapshot: copy(d?.snapshot ?? null), snapshotSeq,
      pendingOps: this.s.ops
        .filter((o) => o.docId === docId && o.seq > snapshotSeq)
        .map((o) => ({ seq: o.seq, ops: JSON.parse(o.ops) as Operation[] })),
    }
  }
  async appendOps(docId: string, ops: Operation[]) {
    const seq = this.s.nextSeq++
    this.s.ops.push({ seq, docId, ops: JSON.stringify(ops) })
    return seq
  }
  async saveSnapshot(docId: string, snapshot: Uint8Array, upToSeq: number) {
    this.s.docs.set(docId, { snapshot: copy(snapshot)!, snapshotSeq: upToSeq })
    this.s.ops = this.s.ops.filter((o) => !(o.docId === docId && o.seq <= upToSeq))
  }
  async deleteDoc(docId: string) {
    this.s.docs.delete(docId)
    this.s.ops = this.s.ops.filter((o) => o.docId !== docId)
    this.s.sync.delete(docId)
    this.s.thumbs.delete(docId)
    this.s.search = this.s.search.filter((d) => d.notebookId !== docId)
  }
  async listDocIds() {
    return [...new Set([...this.s.docs.keys(), ...this.s.ops.map((o) => o.docId)])].sort()
  }
  async indexNotebook(notebookId: NotebookId, docs: SearchDoc[], pageId?: string) {
    this.s.search = this.s.search.filter(
      (d) => !(d.notebookId === notebookId && (pageId === undefined || d.pageId === pageId)))
    this.s.search.push(...docs.map((d) => ({ ...d, notebookId })))
  }
  async search(query: string, limit?: number) { return searchDocs(this.s.search, query, limit) as SearchHit[] }
  async putAsset(id: string, bytes: Uint8Array, mimeType: string) {
    this.s.assets.set(id, { bytes: copy(bytes)!, mimeType })
  }
  async getAsset(id: string) {
    const a = this.s.assets.get(id)
    return a ? { bytes: copy(a.bytes)!, mimeType: a.mimeType } : null
  }
  async getThumbnail(id: NotebookId) { return this.s.thumbs.get(id) ?? null }
  async setThumbnail(id: NotebookId, dataUrl: string) { this.s.thumbs.set(id, dataUrl) }
  async getSyncState(docId: string) {
    const v = this.s.sync.get(docId)
    return v ? { ...v, pushedVersion: copy(v.pushedVersion) } : null
  }
  async setSyncState(st: SyncState) { this.s.sync.set(st.docId, { ...st, pushedVersion: copy(st.pushedVersion) }) }
  async getSetting<T>(key: string) {
    const v = this.s.settings.get(key)
    return v === undefined ? undefined : (JSON.parse(v) as T)
  }
  async setSetting<T>(key: string, value: T) { this.s.settings.set(key, JSON.stringify(value ?? null)) }
}
