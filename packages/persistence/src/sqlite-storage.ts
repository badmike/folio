import type { NotebookId, Operation } from '@folio/document'
import type { SearchDoc, SearchHit, Storage, StoredDoc, SyncState } from './contract'
import { StorageLockedError, StorageUnavailableError } from './errors'
import type { RpcMethod, SqlStore } from './sql-store'

export interface RpcRequest { id: number; method: RpcMethod; args: unknown[] }
export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } }

/** Transport to the SQL engine: a Worker in production, an in-process SqlStore in tests. */
export interface SqlTransport {
  call(method: RpcMethod, args: unknown[], transfer?: Transferable[]): Promise<unknown>
  close(): void
}

/** Transport calling a SqlStore directly (no worker). Used by tests. */
export function inProcessTransport(store: SqlStore): SqlTransport {
  return {
    async call(method, args) {
      if (method === 'init') { store.init(); return { fts: store.usesFts } }
      return (store[method] as (...a: unknown[]) => unknown)(...args)
    },
    close() {},
  }
}

const LOCK_NAME = 'folio-storage-owner'

/**
 * Elects a single owner tab using Web Locks. Resolves with a release function, or
 * throws StorageLockedError when another tab holds the lock. Where Web Locks are
 * unavailable this is a no-op (the sahpool VFS then fails on its own if contended).
 */
export async function acquireStorageLock(name = LOCK_NAME): Promise<() => void> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  if (!locks) return () => {}
  return new Promise<() => void>((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new StorageLockedError())
          return
        }
        // Hold the lock until release() (or the page goes away).
        return new Promise<void>((release) => resolve(() => release()))
      })
      .catch(reject)
  })
}

function workerTransport(worker: Worker): SqlTransport {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  worker.onmessage = (ev: MessageEvent<RpcResponse>) => {
    const r = ev.data
    const p = pending.get(r.id)
    if (!p) return
    pending.delete(r.id)
    if (r.ok) p.resolve(r.result)
    else p.reject(r.error.name === 'StorageLockedError' || /SAH|access handle|NoModificationAllowed/i.test(r.error.message)
      ? new StorageLockedError()
      : Object.assign(new Error(r.error.message), { name: r.error.name }))
  }
  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }
  worker.onerror = (ev) => failAll(new StorageUnavailableError(ev.message || 'storage worker crashed'))
  worker.onmessageerror = () => failAll(new StorageUnavailableError('storage worker message error'))
  return {
    call(method, args, transfer = []) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, method, args } satisfies RpcRequest, transfer)
      })
    },
    close() {
      failAll(new StorageUnavailableError('storage closed'))
      worker.terminate()
    },
  }
}

/** Buffer of `u` if it can be transferred without detaching anyone else's data. */
function transferable(u: Uint8Array): Transferable[] {
  return u.byteOffset === 0 && u.byteLength === u.buffer.byteLength && u.buffer instanceof ArrayBuffer
    ? [u.buffer] : []
}

export interface SqliteStorageOptions {
  /** Override how the engine is reached (tests). Default: Web Lock + dedicated module worker. */
  connect?: () => Promise<SqlTransport>
}

/**
 * Primary storage: SQLite-WASM on OPFS (opfs-sahpool VFS, no COOP/COEP needed) inside a
 * dedicated worker. This class is the main-thread promise proxy.
 */
export class SqliteStorage implements Storage {
  readonly kind = 'sqlite-opfs' as const
  private t: SqlTransport | null = null
  private releaseLock: (() => void) | null = null
  /** True when FTS5 is used for search (false = LIKE fallback). Valid after init(). */
  fts = true

  constructor(private readonly opts: SqliteStorageOptions = {}) {}

  async init(): Promise<void> {
    if (this.t) return
    const connect = this.opts.connect ?? (() => this.connectWorker())
    const t = await connect()
    try {
      const info = (await t.call('init', [])) as { fts: boolean }
      this.fts = info.fts
      this.t = t
    } catch (e) {
      t.close()
      this.releaseLock?.()
      this.releaseLock = null
      throw e
    }
  }

  private async connectWorker(): Promise<SqlTransport> {
    if (typeof Worker === 'undefined') throw new StorageUnavailableError('Web Workers unavailable')
    this.releaseLock = await acquireStorageLock()
    try {
      const worker = new Worker(new URL('./storage.worker.ts', import.meta.url), { type: 'module' })
      return workerTransport(worker)
    } catch (e) {
      this.releaseLock()
      this.releaseLock = null
      throw e
    }
  }

  /** Terminate the worker and give up ownership (lets another tab take over). */
  close(): void {
    this.t?.close()
    this.t = null
    this.releaseLock?.()
    this.releaseLock = null
  }

  private call<T>(method: RpcMethod, args: unknown[] = [], transfer?: Transferable[]): Promise<T> {
    if (!this.t) return Promise.reject(new StorageUnavailableError('storage not initialised'))
    return this.t.call(method, args, transfer) as Promise<T>
  }

  loadDoc(docId: string) { return this.call<StoredDoc>('loadDoc', [docId]) }
  appendOps(docId: string, ops: Operation[]) { return this.call<number>('appendOps', [docId, ops]) }
  saveSnapshot(docId: string, snapshot: Uint8Array, upToSeq: number) {
    return this.call<void>('saveSnapshot', [docId, snapshot, upToSeq], transferable(snapshot))
  }
  deleteDoc(docId: string) { return this.call<void>('deleteDoc', [docId]) }
  listDocIds() { return this.call<string[]>('listDocIds') }
  indexNotebook(notebookId: NotebookId, docs: SearchDoc[], pageId?: string) {
    return this.call<void>('indexNotebook', [notebookId, docs, pageId])
  }
  search(query: string, limit?: number) { return this.call<SearchHit[]>('search', [query, limit]) }
  putAsset(id: string, bytes: Uint8Array, mimeType: string) {
    return this.call<void>('putAsset', [id, bytes, mimeType]) // copied, caller keeps its buffer
  }
  getAsset(id: string) { return this.call<{ bytes: Uint8Array; mimeType: string } | null>('getAsset', [id]) }
  getThumbnail(notebookId: NotebookId) { return this.call<string | null>('getThumbnail', [notebookId]) }
  setThumbnail(notebookId: NotebookId, dataUrl: string) { return this.call<void>('setThumbnail', [notebookId, dataUrl]) }
  getSyncState(docId: string) { return this.call<SyncState | null>('getSyncState', [docId]) }
  setSyncState(state: SyncState) { return this.call<void>('setSyncState', [state]) }
  async getSetting<T>(key: string) { return (await this.call<unknown>('getSetting', [key])) as T | undefined }
  setSetting<T>(key: string, value: T) { return this.call<void>('setSetting', [key, value]) }
}
