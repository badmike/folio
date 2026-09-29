import { LoroDoc, LoroMap, VersionVector } from 'loro-crdt'
import type { WorkspaceDocumentApi } from './api'
import { cloneJson } from './internal'
import type { FolderEntry, FolderId, NotebookEntry, NotebookId, Unsubscribe } from './types'

type Origin = 'local' | 'remote' | 'load'

/**
 * Workspace index: folders + notebook entries.
 *   folders:   Map folderId   -> Map(field -> value)
 *   notebooks: Map notebookId -> Map(field -> value)
 * Deletion is soft (`deleted: true`). Deleting a folder soft-deletes it and its nested
 * folders and moves every notebook inside them to the deleted folder's nearest live
 * ancestor (root if none), so notes are never lost. Reads are also defensive: entries
 * pointing at a deleted/missing folder (e.g. after a concurrent move) resolve upward.
 */
export class WorkspaceDocument implements WorkspaceDocumentApi {
  readonly loro: LoroDoc
  private listeners = new Set<(o: Origin) => void>()
  private cache: { folders: FolderEntry[]; notebooks: NotebookEntry[] } | null = null

  constructor(opts: { peerId?: number | bigint | `${number}`; snapshot?: Uint8Array } = {}) {
    this.loro = new LoroDoc()
    if (opts.peerId !== undefined) this.loro.setPeerId(opts.peerId as never)
    if (opts.snapshot) this.loro.import(opts.snapshot)
  }

  static fromSnapshot(bytes: Uint8Array, opts: { peerId?: number | bigint | `${number}` } = {}): WorkspaceDocument {
    return new WorkspaceDocument({ ...opts, snapshot: bytes })
  }

  private read() {
    if (this.cache) return this.cache
    const json = this.loro.toJSON() as {
      folders?: Record<string, FolderEntry>
      notebooks?: Record<string, NotebookEntry>
    }
    const allFolders = new Map<FolderId, FolderEntry>()
    for (const [id, f] of Object.entries(json.folders ?? {})) {
      if (f && typeof f === 'object') allFolders.set(id, { ...f, id, parentId: f.parentId ?? null })
    }
    const live = (id: FolderId | null | undefined) => (id ? allFolders.get(id) : undefined)
    /** Nearest live folder at or above `id` (cycle-safe); null = root. */
    const resolve = (id: FolderId | null | undefined): FolderId | null => {
      const seen = new Set<FolderId>()
      let cur = id ?? null
      while (cur) {
        if (seen.has(cur)) return null
        seen.add(cur)
        const f = live(cur)
        if (f && !f.deleted) return cur
        cur = f ? f.parentId : null
      }
      return null
    }
    const folders: FolderEntry[] = []
    for (const f of allFolders.values()) {
      if (f.deleted) continue
      const parentId = resolve(f.parentId)
      folders.push(parentId === f.parentId ? f : { ...f, parentId })
    }
    const notebooks: NotebookEntry[] = []
    for (const [id, n] of Object.entries(json.notebooks ?? {})) {
      if (!n || typeof n !== 'object' || n.deleted) continue
      const folderId = resolve(n.folderId)
      notebooks.push({ ...n, id, folderId, tags: n.tags ?? [] })
    }
    folders.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
    notebooks.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
    return (this.cache = { folders, notebooks })
  }

  folders(): FolderEntry[] {
    return this.read().folders.map((f) => cloneJson(f))
  }

  notebooks(): NotebookEntry[] {
    return this.read().notebooks.map((n) => cloneJson(n))
  }

  upsertFolder(f: FolderEntry): void {
    this.put(this.loro.getMap('folders'), f.id, f as unknown as Record<string, unknown>)
    this.commit('local')
  }

  upsertNotebook(n: NotebookEntry): void {
    this.put(this.loro.getMap('notebooks'), n.id, n as unknown as Record<string, unknown>)
    this.commit('local')
  }

  deleteNotebook(id: NotebookId): void {
    const c = this.loro.getMap('notebooks').get(id)
    if (!(c instanceof LoroMap)) return
    c.set('deleted', true)
    c.set('updatedAt', Date.now())
    this.commit('local')
  }

  deleteFolder(id: FolderId): void {
    const folders = this.loro.getMap('folders')
    const root = folders.get(id)
    if (!(root instanceof LoroMap)) return
    const all = this.loro.toJSON().folders as Record<string, FolderEntry>
    const newHome = this.read().folders.find((f) => f.id === id)?.parentId ?? null
    // Collect the folder and every descendant.
    const doomed = new Set<FolderId>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const [fid, f] of Object.entries(all)) {
        if (!doomed.has(fid) && f.parentId && doomed.has(f.parentId)) {
          doomed.add(fid)
          grew = true
        }
      }
    }
    const now = Date.now()
    for (const fid of doomed) {
      const c = folders.get(fid)
      if (c instanceof LoroMap) {
        c.set('deleted', true)
        c.set('updatedAt', now)
      }
    }
    const notebooks = this.loro.getMap('notebooks')
    const nbJson = this.loro.toJSON().notebooks as Record<string, NotebookEntry> | undefined
    for (const [nid, n] of Object.entries(nbJson ?? {})) {
      if (n.folderId && doomed.has(n.folderId)) {
        const c = notebooks.get(nid)
        if (c instanceof LoroMap) {
          if (newHome) c.set('folderId', newHome)
          else c.set('folderId', null)
          c.set('updatedAt', now)
        }
      }
    }
    this.commit('local')
  }

  subscribe(listener: (origin: Origin) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  exportSnapshot(): Uint8Array {
    return this.loro.export({ mode: 'snapshot' })
  }

  exportUpdates(since?: Uint8Array): Uint8Array {
    if (!since) return this.loro.export({ mode: 'update' })
    return this.loro.export({ mode: 'update', from: VersionVector.decode(since) })
  }

  importUpdates(bytes: Uint8Array): void {
    this.loro.import(bytes)
    this.cache = null
    for (const l of [...this.listeners]) l('remote')
  }

  version(): Uint8Array {
    return this.loro.oplogVersion().encode()
  }

  private put(root: LoroMap, id: string, value: Record<string, unknown>): void {
    let c = root.get(id)
    if (!(c instanceof LoroMap)) c = root.setContainer(id, new LoroMap())
    const m = c as LoroMap
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id') continue
      if (k === 'deleted' && !v) {
        if (m.get('deleted') !== undefined) m.delete('deleted')
        continue
      }
      if (v !== undefined) m.set(k, v as never)
    }
  }

  private commit(origin: Origin): void {
    this.loro.commit({ origin })
    this.cache = null
    for (const l of [...this.listeners]) l(origin)
  }
}
