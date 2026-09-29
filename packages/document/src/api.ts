import type {
  CanvasObject, DocChangeEvent, FolderEntry, FolderId, NotebookEntry, NotebookId, NotebookMeta,
  ObjectId, Operation, Page, PageId, Recognition, Unsubscribe,
} from './types'

/**
 * A notebook backed by a CRDT (Loro). Keeps a materialised, read-optimised cache
 * so the editor/renderer never have to walk CRDT structures on the hot path.
 * All mutations go through `apply()`; remote bytes go through `importUpdates()`.
 */
export interface NotebookDocumentApi {
  readonly id: NotebookId
  meta(): NotebookMeta
  pages(): Page[] // sorted by `order`
  page(id: PageId): Page | undefined
  objects(pageId: PageId): CanvasObject[] // sorted by z, INCLUDING superseded ones
  object(pageId: PageId, id: ObjectId): CanvasObject | undefined
  recognitions(pageId: PageId): Recognition[]

  /** Apply application operations atomically (one CRDT commit). */
  apply(ops: Operation[], origin?: 'local' | 'journal'): void
  /** Compute operations that undo `ops` against the CURRENT state (call before apply). */
  inverse(ops: Operation[]): Operation[]
  subscribe(listener: (e: DocChangeEvent) => void): Unsubscribe

  /** Full CRDT snapshot. */
  exportSnapshot(): Uint8Array
  /** CRDT updates since the given encoded version vector (undefined = everything). */
  exportUpdates(since?: Uint8Array): Uint8Array
  importUpdates(bytes: Uint8Array): void
  /** Encoded version vector of current state. */
  version(): Uint8Array
}

/** Workspace index doc (folders + notebook entries), also CRDT-backed and synced. */
export interface WorkspaceDocumentApi {
  folders(): FolderEntry[] // excluding deleted
  notebooks(): NotebookEntry[] // excluding deleted
  upsertFolder(f: FolderEntry): void
  deleteFolder(id: FolderId): void
  upsertNotebook(n: NotebookEntry): void
  deleteNotebook(id: NotebookId): void
  subscribe(listener: (origin: 'local' | 'remote' | 'load') => void): Unsubscribe
  exportSnapshot(): Uint8Array
  exportUpdates(since?: Uint8Array): Uint8Array
  importUpdates(bytes: Uint8Array): void
  version(): Uint8Array
}
