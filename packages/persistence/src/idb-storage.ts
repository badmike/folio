import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { NotebookId, Operation } from '@folio/document'
import type { SearchDoc, Storage, StoredDoc, SyncState } from './contract'
import { searchDocs } from './text'

interface Schema extends DBSchema {
  docs: { key: string; value: { docId: string; snapshot: Uint8Array; snapshotSeq: number; updatedAt: number } }
  ops: {
    key: number
    value: { docId: string; ops: Operation[]; createdAt: number }
    indexes: { docId: string }
  }
  search: { key: number; value: SearchDoc; indexes: { notebookId: string } }
  assets: { key: string; value: { bytes: Uint8Array; mimeType: string } }
  thumbs: { key: string; value: string }
  sync: { key: string; value: SyncState }
  settings: { key: string; value: unknown }
}

const strict = { durability: 'strict' } as const

/** IndexedDB fallback for browsers without OPFS/workers. Search loads candidates in memory. */
export class IdbStorage implements Storage {
  readonly kind = 'indexeddb' as const
  private db!: IDBPDatabase<Schema>
  constructor(private readonly name = 'folio') {}

  async init() {
    if (this.db) return
    this.db = await openDB<Schema>(this.name, 1, {
      upgrade(db) {
        db.createObjectStore('docs', { keyPath: 'docId' })
        db.createObjectStore('ops', { autoIncrement: true }).createIndex('docId', 'docId')
        db.createObjectStore('search', { autoIncrement: true }).createIndex('notebookId', 'notebookId')
        db.createObjectStore('assets')
        db.createObjectStore('thumbs')
        db.createObjectStore('sync')
        db.createObjectStore('settings')
      },
    })
  }

  async loadDoc(docId: string): Promise<StoredDoc> {
    const tx = this.db.transaction(['docs', 'ops'], 'readonly')
    const d = await tx.objectStore('docs').get(docId)
    const snapshotSeq = d?.snapshotSeq ?? 0
    const range = IDBKeyRange.lowerBound(snapshotSeq, true)
    const pendingOps: StoredDoc['pendingOps'] = []
    // Iterate the docId index; keys within one docId come back in primary-key (seq) order.
    let cur = await tx.objectStore('ops').index('docId').openCursor(docId)
    while (cur) {
      if (range.includes(cur.primaryKey)) pendingOps.push({ seq: cur.primaryKey, ops: cur.value.ops })
      cur = await cur.continue()
    }
    await tx.done
    return { snapshot: d ? new Uint8Array(d.snapshot) : null, snapshotSeq, pendingOps }
  }

  async appendOps(docId: string, ops: Operation[]) {
    const tx = this.db.transaction('ops', 'readwrite', strict)
    const seq = await tx.store.add({ docId, ops, createdAt: Date.now() })
    await tx.done
    return seq
  }

  async saveSnapshot(docId: string, snapshot: Uint8Array, upToSeq: number) {
    const tx = this.db.transaction(['docs', 'ops'], 'readwrite', strict)
    await tx.objectStore('docs').put({ docId, snapshot: new Uint8Array(snapshot), snapshotSeq: upToSeq, updatedAt: Date.now() })
    let cur = await tx.objectStore('ops').index('docId').openCursor(docId)
    while (cur) {
      if (cur.primaryKey <= upToSeq) await cur.delete()
      cur = await cur.continue()
    }
    await tx.done
  }

  async deleteDoc(docId: string) {
    const tx = this.db.transaction(['docs', 'ops', 'sync', 'thumbs', 'search'], 'readwrite', strict)
    await tx.objectStore('docs').delete(docId)
    await tx.objectStore('sync').delete(docId)
    await tx.objectStore('thumbs').delete(docId)
    for (const [store, index] of [['ops', 'docId'], ['search', 'notebookId']] as const) {
      let cur = await tx.objectStore(store).index(index as never).openCursor(docId as never)
      while (cur) { await cur.delete(); cur = await cur.continue() }
    }
    await tx.done
  }

  async listDocIds() {
    const tx = this.db.transaction(['docs', 'ops'], 'readonly')
    const ids = new Set<string>(await tx.objectStore('docs').getAllKeys())
    let cur = await tx.objectStore('ops').index('docId').openKeyCursor(undefined, 'nextunique')
    while (cur) { ids.add(cur.key); cur = await cur.continue() }
    await tx.done
    return [...ids].sort()
  }

  async indexNotebook(notebookId: NotebookId, docs: SearchDoc[], pageId?: string) {
    const tx = this.db.transaction('search', 'readwrite')
    let cur = await tx.store.index('notebookId').openCursor(notebookId)
    while (cur) {
      if (pageId === undefined || cur.value.pageId === pageId) await cur.delete()
      cur = await cur.continue()
    }
    for (const d of docs) await tx.store.add({ ...d, notebookId })
    await tx.done
  }

  async search(query: string, limit?: number) {
    return searchDocs(await this.db.getAll('search'), query, limit)
  }

  async putAsset(id: string, bytes: Uint8Array, mimeType: string) {
    const tx = this.db.transaction('assets', 'readwrite', strict)
    await tx.store.put({ bytes: new Uint8Array(bytes), mimeType }, id)
    await tx.done
  }
  async getAsset(id: string) {
    const a = await this.db.get('assets', id)
    return a ? { bytes: new Uint8Array(a.bytes), mimeType: a.mimeType } : null
  }
  async getThumbnail(id: NotebookId) { return (await this.db.get('thumbs', id)) ?? null }
  async setThumbnail(id: NotebookId, dataUrl: string) { await this.db.put('thumbs', dataUrl, id) }
  async getSyncState(docId: string) { return (await this.db.get('sync', docId)) ?? null }
  async setSyncState(s: SyncState) { await this.db.put('sync', s, s.docId) }
  async getSetting<T>(key: string) { return (await this.db.get('settings', key)) as T | undefined }
  async setSetting<T>(key: string, value: T) {
    const tx = this.db.transaction('settings', 'readwrite', strict)
    await tx.store.put(value, key)
    await tx.done
  }
}
