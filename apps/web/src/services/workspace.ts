import {
  NotebookDocument, WorkspaceDocument, createId, createPage, defaultBackground, exportFolio, exportMarkdown,
  importFolio, searchDocsFor,
  CANVAS_BACKGROUNDS_DARK, defaultLineColor,
  type AssetMap, type BackgroundPattern, type PageBackground, type FolderEntry, type FolderId, type NotebookEntry, type NotebookId,
  type Operation, type Page,
} from '@folio/document'
import { DocPersister, type Diagnostics, type SearchHit, type Storage } from '@folio/persistence'
import { welcomeOperations } from './welcome'
import { settings, type DefaultPageType } from './settings'

export const WORKSPACE_DOC_ID = 'workspace'
const OPEN_CACHE_LIMIT = 6
const TOUCH_DELAY_MS = 2000
const REINDEX_DELAY_MS = 1500

export class NotebookNotFoundError extends Error {
  override name = 'NotebookNotFoundError'
}

export interface NewNotebookOptions {
  title?: string
  pageType?: DefaultPageType
  pattern?: BackgroundPattern
  folderId?: FolderId | null
  tags?: string[]
}

/** Default page background; follows the app's light/dark scheme when the setting is on. */
export function themedBackground(pattern: BackgroundPattern): PageBackground {
  const bg = defaultBackground(pattern)
  const dark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
  if (settings.canvasFollowsTheme && dark) {
    const color = CANVAS_BACKGROUNDS_DARK[0]
    return { ...bg, color, lineColor: defaultLineColor(color) }
  }
  return bg
}

/** Build the first page for a new notebook. */
export function pageFor(type: DefaultPageType, pattern: BackgroundPattern, order = 1): Page {
  const background = themedBackground(pattern)
  return type === 'infinite'
    ? createPage({ kind: 'infinite', order, background })
    : createPage({ kind: 'fixed', format: type, order, background })
}

/**
 * An open notebook: the CRDT document, its persister (journal + snapshots) and hooks
 * that tell the workspace about local changes.
 */
export class NotebookSession {
  refs = 0
  lastUse = Date.now()
  lastSyncUse = 0
  private readonly unsub: () => void

  constructor(
    readonly doc: NotebookDocument,
    readonly persister: DocPersister<NotebookDocument>,
    private readonly ws: Workspace,
  ) {
    this.unsub = doc.subscribe((e) => { if (e.origin === 'remote') ws.handleRemoteDocChange(doc.id) })
  }

  get id(): NotebookId { return this.doc.id }

  /** Apply operations that did NOT come from the editor (page panel, AI, recognition…). */
  apply(ops: Operation[]): void {
    if (!ops.length) return
    this.doc.apply(ops, 'local')
    this.recorded(ops)
  }

  /** Persist + announce operations that were already applied to the doc (editor commits). */
  recorded(ops: Operation[]): void {
    void this.persister.record(ops)
    this.ws.handleLocalDocChange(this.doc.id)
  }

  async close(): Promise<void> {
    this.unsub()
    await this.persister.dispose()
  }
}

type Listener = () => void

/**
 * Application-level data service: workspace index (folders/notebooks), open notebook
 * sessions, thumbnails, search indexing and import/export. Framework independent.
 */
export class Workspace {
  readonly doc: WorkspaceDocument
  private readonly wsPersister: DocPersister<WorkspaceDocument>
  private readonly sessions = new Map<NotebookId, NotebookSession>()
  private readonly opening = new Map<NotebookId, Promise<NotebookSession>>()
  private readonly touchTimers = new Map<NotebookId, ReturnType<typeof setTimeout>>()
  private readonly indexTimers = new Map<NotebookId, ReturnType<typeof setTimeout>>()
  private readonly changeListeners = new Set<Listener>()
  private readonly thumbListeners = new Set<(id: NotebookId) => void>()
  private readonly localListeners = new Set<(docId: string) => void>()
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  private constructor(
    readonly storage: Storage,
    readonly deviceId: string,
    readonly peerId: number,
    doc: WorkspaceDocument,
    wsPersister: DocPersister<WorkspaceDocument>,
    private readonly diagnostics?: Diagnostics,
  ) {
    this.doc = doc
    this.wsPersister = wsPersister
    doc.subscribe((origin) => {
      if (origin === 'local') {
        this.persistWorkspaceSoon()
        for (const l of this.localListeners) l(WORKSPACE_DOC_ID)
      }
      this.emitChange()
    })
  }

  /** Boot: device id, stable Loro peer id, workspace document. */
  static async open(storage: Storage, diagnostics?: Diagnostics): Promise<Workspace> {
    let deviceId = await storage.getSetting<string>('deviceId')
    if (!deviceId) {
      deviceId = createId()
      await storage.setSetting('deviceId', deviceId)
    }
    let peerId = await storage.getSetting<number>('peerId')
    if (typeof peerId !== 'number') {
      // stable random 53-bit integer (Loro peer ids are u64; JS numbers are exact up to 2^53)
      const a = new Uint32Array(2)
      crypto.getRandomValues(a)
      peerId = (a[0] & 0x1fffff) * 2 ** 32 + a[1]
      if (peerId === 0) peerId = 1
      await storage.setSetting('peerId', peerId)
    }
    const persister = new DocPersister<WorkspaceDocument>(storage, {
      onError: (e, info) => diagnostics?.log(`persist.${info.phase}`, e, { docId: info.docId }),
    })
    const pid = peerId
    const doc = await persister.load(WORKSPACE_DOC_ID, {
      fromSnapshot: (b) => WorkspaceDocument.fromSnapshot(b, { peerId: pid }),
      empty: () => new WorkspaceDocument({ peerId: pid }),
    })
    return new Workspace(storage, deviceId, peerId, doc, persister, diagnostics)
  }

  // ---------------------------------------------------------------------------
  // change notification
  // ---------------------------------------------------------------------------

  /** Called when the library (folders/notebooks index) changed. Returns unsubscribe. */
  onChange(cb: Listener): () => void {
    this.changeListeners.add(cb)
    return () => this.changeListeners.delete(cb)
  }
  onThumbnail(cb: (id: NotebookId) => void): () => void {
    this.thumbListeners.add(cb)
    return () => this.thumbListeners.delete(cb)
  }
  /** Called for every local commit to a document ('workspace' or notebook id) — used by sync. */
  onLocalChange(cb: (docId: string) => void): () => void {
    this.localListeners.add(cb)
    return () => this.localListeners.delete(cb)
  }
  private emitChange() {
    for (const l of [...this.changeListeners]) l()
  }

  /** @internal */
  handleLocalDocChange(id: NotebookId): void {
    for (const l of this.localListeners) l(id)
    this.scheduleTouch(id)
    this.scheduleReindex(id)
  }

  /** @internal */
  handleRemoteDocChange(id: NotebookId): void {
    this.scheduleReindex(id)
    this.emitChange()
  }

  private persistWorkspaceSoon(): void {
    // The workspace doc has no operation journal, so snapshot it promptly (it is tiny).
    void this.wsPersister.record([{ type: 'updateMeta', patch: {} }])
    clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.wsPersister.flush().catch((e) => this.diagnostics?.log('workspace.flush', e))
    }, 250)
  }

  // ---------------------------------------------------------------------------
  // queries
  // ---------------------------------------------------------------------------

  folders(): FolderEntry[] { return this.doc.folders() }
  notebooks(): NotebookEntry[] { return this.doc.notebooks() }
  entry(id: NotebookId): NotebookEntry | undefined { return this.doc.notebooks().find((n) => n.id === id) }
  allTags(): string[] {
    const set = new Set<string>()
    for (const n of this.notebooks()) for (const t of n.tags) set.add(t)
    return [...set].sort((a, b) => a.localeCompare(b))
  }

  /** Full-text search over titles, tags, typed text, handwriting and labels. */
  search(query: string, limit = 50): Promise<SearchHit[]> {
    const q = query.trim()
    return q ? this.storage.search(q, limit) : Promise.resolve([])
  }

  // ---------------------------------------------------------------------------
  // notebook sessions
  // ---------------------------------------------------------------------------

  private async loadSession(id: NotebookId): Promise<NotebookSession> {
    const peerId = this.peerId
    const persister = new DocPersister<NotebookDocument>(this.storage, {
      onError: (e, info) => this.diagnostics?.log(`persist.${info.phase}`, e, { docId: info.docId }),
    })
    const doc = await persister.load(id, {
      fromSnapshot: (b) => NotebookDocument.fromSnapshot(b, { peerId }),
      empty: () => NotebookDocument.empty(id, { peerId }),
    })
    return new NotebookSession(doc, persister, this)
  }

  private async session(id: NotebookId): Promise<NotebookSession> {
    const cached = this.sessions.get(id)
    if (cached) return cached
    let p = this.opening.get(id)
    if (!p) {
      p = this.loadSession(id).then((s) => { this.sessions.set(id, s); return s }).finally(() => this.opening.delete(id))
      this.opening.set(id, p)
    }
    return p
  }

  /**
   * Open a notebook for the UI (call `release` when done). Throws NotebookNotFoundError
   * if no such notebook exists locally.
   */
  async openNotebook(id: NotebookId): Promise<NotebookSession> {
    const s = await this.session(id)
    if (s.doc.pages().length === 0) {
      if (s.refs === 0) await this.dropSession(id)
      throw new NotebookNotFoundError(`Notebook ${id} not found`)
    }
    s.refs++
    s.lastUse = Date.now()
    return s
  }

  async release(id: NotebookId): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    s.refs = Math.max(0, s.refs - 1)
    await this.flushNotebook(id)
    await this.evictIdle()
  }

  /** Open (creating an empty local doc if unknown) for the sync engine. */
  async openForSync(id: NotebookId): Promise<NotebookSession> {
    const s = await this.session(id)
    s.lastSyncUse = Date.now()
    return s
  }

  /** Make a document durable now (used before sync advances its pulled sequence). */
  async flushDoc(docId: string): Promise<void> {
    if (docId === WORKSPACE_DOC_ID) return this.wsPersister.flush()
    await this.sessions.get(docId)?.persister.flush()
  }

  private async dropSession(id: NotebookId): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    await s.close().catch((e) => this.diagnostics?.log('session.close', e))
  }

  private async evictIdle(): Promise<void> {
    if (this.sessions.size <= OPEN_CACHE_LIMIT) return
    const idle = [...this.sessions.values()]
      .filter((s) => s.refs === 0 && Date.now() - s.lastSyncUse > 60_000 && !this.opening.has(s.id))
      .sort((a, b) => a.lastUse - b.lastUse)
    for (const s of idle) {
      if (this.sessions.size <= OPEN_CACHE_LIMIT) break
      await this.flushNotebook(s.id)
      await this.dropSession(s.id)
    }
  }

  private async withSession<T>(id: NotebookId, fn: (s: NotebookSession) => T | Promise<T>): Promise<T> {
    const s = await this.session(id)
    s.refs++
    try { return await fn(s) } finally { s.refs--; void this.evictIdle() }
  }

  // ---------------------------------------------------------------------------
  // touch (entry.updatedAt / title / tags) and search indexing
  // ---------------------------------------------------------------------------

  private scheduleTouch(id: NotebookId) {
    clearTimeout(this.touchTimers.get(id))
    this.touchTimers.set(id, setTimeout(() => this.touchNow(id), TOUCH_DELAY_MS))
  }

  private touchNow(id: NotebookId) {
    clearTimeout(this.touchTimers.get(id))
    this.touchTimers.delete(id)
    const e = this.entry(id)
    const s = this.sessions.get(id)
    if (!e || !s || this.disposed) return
    const meta = s.doc.meta()
    this.doc.upsertNotebook({ ...e, title: meta.title || e.title, tags: meta.tags, updatedAt: Date.now() })
  }

  private scheduleReindex(id: NotebookId) {
    clearTimeout(this.indexTimers.get(id))
    this.indexTimers.set(id, setTimeout(() => void this.reindexNow(id), REINDEX_DELAY_MS))
  }

  async reindexNow(id: NotebookId): Promise<void> {
    clearTimeout(this.indexTimers.get(id))
    this.indexTimers.delete(id)
    const s = this.sessions.get(id)
    if (!s || this.disposed) return
    try {
      await this.storage.indexNotebook(id, searchDocsFor(s.doc))
    } catch (e) {
      this.diagnostics?.log('search.index', e, { docId: id })
    }
  }

  /** Persist a notebook and run pending touch / index work immediately. */
  async flushNotebook(id: NotebookId): Promise<void> {
    if (this.touchTimers.has(id)) this.touchNow(id)
    if (this.indexTimers.has(id)) await this.reindexNow(id)
    await this.sessions.get(id)?.persister.flush()
  }

  /** Flush every open notebook and the workspace. */
  async flushAll(): Promise<void> {
    for (const id of [...this.touchTimers.keys()]) this.touchNow(id)
    clearTimeout(this.persistTimer)
    await Promise.all([
      this.wsPersister.flush(),
      ...[...this.sessions.keys()].map((id) => this.flushNotebook(id)),
    ])
  }

  // ---------------------------------------------------------------------------
  // thumbnails
  // ---------------------------------------------------------------------------

  getThumbnail(id: NotebookId): Promise<string | null> { return this.storage.getThumbnail(id) }
  async setThumbnail(id: NotebookId, dataUrl: string): Promise<void> {
    await this.storage.setThumbnail(id, dataUrl)
    for (const l of this.thumbListeners) l(id)
  }

  // ---------------------------------------------------------------------------
  // notebook CRUD
  // ---------------------------------------------------------------------------

  private async register(doc: NotebookDocument, folderId: FolderId | null): Promise<NotebookEntry> {
    // Write a snapshot first so the notebook is loadable (and its id is in the CRDT) from the start.
    await this.storage.saveSnapshot(doc.id, doc.exportSnapshot(), 0)
    const meta = doc.meta()
    const entry: NotebookEntry = {
      id: doc.id, title: meta.title, folderId, tags: meta.tags, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
    }
    this.doc.upsertNotebook(entry)
    await this.storage.indexNotebook(doc.id, searchDocsFor(doc)).catch((e) => this.diagnostics?.log('search.index', e))
    return entry
  }

  async createNotebook(opts: NewNotebookOptions = {}): Promise<NotebookId> {
    const now = Date.now()
    const doc = NotebookDocument.create(
      { title: opts.title?.trim() || 'Untitled', tags: opts.tags ?? [], createdAt: now, updatedAt: now },
      { peerId: this.peerId, now },
    )
    const type = opts.pageType ?? 'infinite'
    const pattern = opts.pattern ?? 'blank'
    if (type !== 'infinite' || pattern !== 'blank') {
      const first = doc.pages()[0]
      const page = pageFor(type, pattern)
      doc.apply([{ type: 'addPage', page }, { type: 'deletePage', pageId: first.id }])
    } else {
      const bg = themedBackground('blank')
      if (bg.color !== doc.pages()[0].background.color) doc.apply([{ type: 'updatePage', pageId: doc.pages()[0].id, patch: { background: bg } }])
    }
    return (await this.register(doc, opts.folderId ?? null)).id
  }

  /** First-run sample notebook. */
  async createWelcomeNotebook(): Promise<NotebookId> {
    const now = Date.now()
    const doc = NotebookDocument.create({ title: 'Welcome', tags: [], createdAt: now, updatedAt: now }, { peerId: this.peerId, now })
    const pageId = doc.pages()[0].id
    doc.apply([{ type: 'updatePage', pageId, patch: { background: defaultBackground('dot') } }, ...welcomeOperations(pageId, now)])
    return (await this.register(doc, null)).id
  }

  /** Create the Welcome notebook exactly once, on first run. */
  async ensureFirstRun(): Promise<NotebookId | null> {
    if (await this.storage.getSetting<boolean>('firstRunDone')) return null
    await this.storage.setSetting('firstRunDone', true)
    if (this.notebooks().length > 0) return null // e.g. synced from another device already
    return this.createWelcomeNotebook()
  }

  async duplicateNotebook(id: NotebookId): Promise<NotebookId> {
    const src = this.entry(id)
    return this.withSession(id, async (s) => {
      await s.persister.flush()
      const copy = NotebookDocument.fromSnapshot(s.doc.exportSnapshot(), { peerId: this.peerId })
      const newId = createId()
      copy.rekey(newId)
      const now = Date.now()
      copy.apply([{ type: 'updateMeta', patch: { title: `${s.doc.meta().title || 'Untitled'} copy`, createdAt: now, updatedAt: now } }])
      return (await this.register(copy, src?.folderId ?? null)).id
    })
  }

  async renameNotebook(id: NotebookId, title: string): Promise<void> {
    const t = title.trim() || 'Untitled'
    await this.withSession(id, (s) => s.apply([{ type: 'updateMeta', patch: { title: t } }]))
    const e = this.entry(id)
    if (e) this.doc.upsertNotebook({ ...e, title: t, updatedAt: Date.now() })
  }

  async setTags(id: NotebookId, tags: string[]): Promise<void> {
    const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
    await this.withSession(id, (s) => s.apply([{ type: 'updateMeta', patch: { tags: clean } }]))
    const e = this.entry(id)
    if (e) this.doc.upsertNotebook({ ...e, tags: clean, updatedAt: Date.now() })
  }

  moveNotebook(id: NotebookId, folderId: FolderId | null): void {
    const e = this.entry(id)
    if (e) this.doc.upsertNotebook({ ...e, folderId, updatedAt: Date.now() })
  }

  async deleteNotebook(id: NotebookId): Promise<void> {
    // Soft delete in the workspace (sync-friendly); the document itself is kept locally.
    for (const t of [this.touchTimers, this.indexTimers]) {
      clearTimeout(t.get(id))
      t.delete(id)
    }
    await this.dropSession(id)
    this.doc.deleteNotebook(id)
    await this.storage.indexNotebook(id, []).catch((e) => this.diagnostics?.log('search.index', e))
  }

  // ---------------------------------------------------------------------------
  // folders
  // ---------------------------------------------------------------------------

  createFolder(name: string, parentId: FolderId | null = null): FolderId {
    const now = Date.now()
    const f: FolderEntry = { id: createId(), name: name.trim() || 'New folder', parentId, createdAt: now, updatedAt: now }
    this.doc.upsertFolder(f)
    return f.id
  }

  renameFolder(id: FolderId, name: string): void {
    const f = this.folders().find((x) => x.id === id)
    if (f) this.doc.upsertFolder({ ...f, name: name.trim() || f.name, updatedAt: Date.now() })
  }

  /** Move a folder; refuses to move it into itself or one of its descendants. */
  moveFolder(id: FolderId, parentId: FolderId | null): boolean {
    const folders = this.folders()
    const f = folders.find((x) => x.id === id)
    if (!f) return false
    for (let cur: FolderId | null = parentId; cur; cur = folders.find((x) => x.id === cur)?.parentId ?? null) {
      if (cur === id) return false
    }
    this.doc.upsertFolder({ ...f, parentId, updatedAt: Date.now() })
    return true
  }

  /** Deletes the folder and its subfolders; notebooks move to the nearest surviving parent. */
  deleteFolder(id: FolderId): void {
    this.doc.deleteFolder(id)
  }

  // ---------------------------------------------------------------------------
  // import / export
  // ---------------------------------------------------------------------------

  private async collectAssets(doc: NotebookDocument): Promise<AssetMap> {
    const assets: AssetMap = new Map()
    for (const p of doc.pages()) {
      for (const o of doc.objects(p.id)) {
        if (o.type === 'image' && !assets.has(o.assetId)) {
          const a = await this.storage.getAsset(o.assetId)
          if (a) assets.set(o.assetId, a)
        }
      }
    }
    return assets
  }

  async exportFolioBytes(id: NotebookId, preview?: Uint8Array): Promise<Uint8Array> {
    return this.withSession(id, async (s) => exportFolio(s.doc, await this.collectAssets(s.doc), preview))
  }

  async exportMarkdownText(id: NotebookId): Promise<string> {
    return this.withSession(id, (s) => exportMarkdown(s.doc))
  }

  /** Import a .folio archive as a new notebook (fresh id). */
  async importFolioBytes(bytes: Uint8Array, folderId: FolderId | null = null): Promise<NotebookId> {
    const { doc, assets } = importFolio(bytes, { newId: true })
    for (const [aid, a] of assets) await this.storage.putAsset(aid, a.bytes, a.mimeType)
    // re-open with our peer id so later edits never collide with the exporting device
    const local = NotebookDocument.fromSnapshot(doc.exportSnapshot(), { peerId: this.peerId })
    const now = Date.now()
    local.apply([{ type: 'updateMeta', patch: { updatedAt: now } }])
    return (await this.register(local, folderId)).id
  }

  // ---------------------------------------------------------------------------

  async dispose(): Promise<void> {
    await this.flushAll()
    this.disposed = true
    for (const s of [...this.sessions.keys()]) await this.dropSession(s)
    await this.wsPersister.dispose()
    this.changeListeners.clear()
    this.localListeners.clear()
  }
}
