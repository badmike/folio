import type { NotebookId, Operation } from '@folio/document'

export interface SearchDoc {
  notebookId: NotebookId
  pageId: string | null
  /** Object/recognition id or null for notebook-level docs (title/tags). */
  objectId: string | null
  kind: 'title' | 'tag' | 'text' | 'handwriting' | 'label'
  text: string
  /** World-space bounds for camera navigation. */
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface SearchHit extends SearchDoc {
  snippet: string
  rank: number
}

export interface StoredDoc {
  snapshot: Uint8Array | null
  /** Journal ops with seq > snapshotSeq, oldest first — replay these after loading the snapshot. */
  pendingOps: { seq: number; ops: Operation[] }[]
  snapshotSeq: number
}

export interface SyncState {
  docId: string
  /** Encoded CRDT version vector last pushed to the server. */
  pushedVersion: Uint8Array | null
  /** Last server sequence number pulled. */
  pulledSeq: number
}

/**
 * Local-first storage. docId is a notebook id or the literal 'workspace'.
 * Implementations: SqliteStorage (SQLite-WASM + OPFS in a worker, primary),
 * IdbStorage (IndexedDB fallback), MemoryStorage (tests).
 */
export interface Storage {
  readonly kind: 'sqlite-opfs' | 'indexeddb' | 'memory'
  init(): Promise<void>

  loadDoc(docId: string): Promise<StoredDoc>
  /** Append to the operation journal (called right after every local commit). Returns seq. */
  appendOps(docId: string, ops: Operation[]): Promise<number>
  /** Store a full snapshot covering all journal ops up to `upToSeq`, then compact the journal. */
  saveSnapshot(docId: string, snapshot: Uint8Array, upToSeq: number): Promise<void>
  deleteDoc(docId: string): Promise<void>
  listDocIds(): Promise<string[]>

  /** Replace all search docs for a notebook (or a page of it when pageId given). */
  indexNotebook(notebookId: NotebookId, docs: SearchDoc[], pageId?: string): Promise<void>
  search(query: string, limit?: number): Promise<SearchHit[]>

  putAsset(id: string, bytes: Uint8Array, mimeType: string): Promise<void>
  getAsset(id: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>

  getThumbnail(notebookId: NotebookId): Promise<string | null>
  setThumbnail(notebookId: NotebookId, dataUrl: string): Promise<void>

  getSyncState(docId: string): Promise<SyncState | null>
  setSyncState(state: SyncState): Promise<void>

  getSetting<T>(key: string): Promise<T | undefined>
  setSetting<T>(key: string, value: T): Promise<void>
}
