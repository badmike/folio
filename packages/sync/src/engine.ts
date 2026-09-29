import type { Storage, SyncState } from '@folio/persistence'
import { SyncApi, SyncHttpError } from './api'
import { bytesEqual } from './base64'

/** Structurally satisfied by NotebookDocument and WorkspaceDocument. */
export interface DocHandle {
  exportUpdates(since?: Uint8Array): Uint8Array
  importUpdates(bytes: Uint8Array): void
  version(): Uint8Array
  exportSnapshot(): Uint8Array
}

export type SyncStateName = 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out'

export interface SyncStatus {
  state: SyncStateName
  lastSyncedAt: number | null
  error?: string
  /** Documents with local changes that have not been confirmed pushed. */
  pending: number
}

export interface SyncLogger {
  debug?(...a: unknown[]): void
  warn?(...a: unknown[]): void
  error?(...a: unknown[]): void
}

export interface SyncEngineOptions {
  api: Pick<SyncApi, 'push' | 'pull' | 'compact' | 'listDocs'>
  storage: Storage
  deviceId: string
  /**
   * Returns the local document for `docId`. For ids only known to the server the
   * implementation must create an empty local document (the engine then imports the
   * remote state into it). Return null to skip a doc.
   */
  openDoc: (docId: string) => Promise<DocHandle | null>
  /** Called after a document that only existed on the server has been materialised. */
  onRemoteDoc?: (docId: string) => void
  logger?: SyncLogger
  /** Periodic sync interval (default 30 s). */
  intervalMs?: number
  /** Debounce for notifyLocalChange (default 1500 ms). */
  debounceMs?: number
  /** Page size for pulls (default 200). */
  pullLimit?: number
  /** Compact once this many server updates were pulled since the last compaction (default 200). */
  compactThreshold?: number
  /** Backoff bounds (default 2 s .. 5 min). */
  backoffBaseMs?: number
  backoffMaxMs?: number
  now?: () => number
  random?: () => number
}

export const WORKSPACE_DOC_ID = 'workspace'

const compactedKey = (docId: string) => `sync.compactedSeq.${docId}`

export class SyncEngine {
  private readonly o: Required<Omit<SyncEngineOptions, 'onRemoteDoc' | 'logger'>> &
    Pick<SyncEngineOptions, 'onRemoteDoc' | 'logger'>
  private status: SyncStatus = { state: 'idle', lastSyncedAt: null, pending: 0 }
  private readonly listeners = new Set<(s: SyncStatus) => void>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly dirty = new Set<string>()
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private active = 0
  private failures = 0
  private retryAfterMs = 0
  private failure: { state: SyncStateName; error: string } | null = null
  private allRun: Promise<void> | null = null
  private cleanup: (() => void)[] = []

  constructor(opts: SyncEngineOptions) {
    this.o = {
      intervalMs: 30_000,
      debounceMs: 1500,
      pullLimit: 200,
      compactThreshold: 200,
      backoffBaseMs: 2000,
      backoffMaxMs: 300_000,
      now: () => Date.now(),
      random: Math.random,
      ...(Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as unknown as SyncEngineOptions),
    }
  }

  // ---- status ----------------------------------------------------------

  getStatus(): SyncStatus { return this.status }

  /** Calls `cb` immediately and on every change. Returns an unsubscribe function. */
  subscribe(cb: (s: SyncStatus) => void): () => void {
    this.listeners.add(cb)
    cb(this.status)
    return () => { this.listeners.delete(cb) }
  }

  private publish(): void {
    const state: SyncStateName = this.active > 0 ? 'syncing' : this.failure?.state ?? 'idle'
    const next: SyncStatus = {
      state,
      lastSyncedAt: this.status.lastSyncedAt,
      pending: this.dirty.size,
      ...(this.failure && this.active === 0 ? { error: this.failure.error } : {}),
    }
    const s = this.status
    if (s.state === next.state && s.pending === next.pending && s.error === next.error && s.lastSyncedAt === next.lastSyncedAt) return
    this.status = next
    for (const l of [...this.listeners]) {
      try { l(next) } catch (e) { this.o.logger?.error?.('sync listener failed', e) }
    }
  }

  // ---- lifecycle -------------------------------------------------------

  start(): void {
    if (this.running) return
    this.running = true
    const trigger = () => { this.failures = 0; this.retryAfterMs = 0; void this.runLoop() }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', trigger)
      this.cleanup.push(() => window.removeEventListener('online', trigger))
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      const vis = () => { if (document.visibilityState === 'visible') trigger() }
      document.addEventListener('visibilitychange', vis)
      this.cleanup.push(() => document.removeEventListener('visibilitychange', vis))
    }
    void this.runLoop()
  }

  stop(): void {
    this.running = false
    for (const c of this.cleanup) c()
    this.cleanup = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
  }

  /** Marks a doc as changed locally and schedules a debounced sync. Never blocks. */
  notifyLocalChange(docId: string): void {
    this.dirty.add(docId)
    this.publish()
    if (!this.running) return
    const prev = this.debounceTimers.get(docId)
    if (prev) clearTimeout(prev)
    this.debounceTimers.set(docId, setTimeout(() => {
      this.debounceTimers.delete(docId)
      // While backing off or signed out the periodic loop does the retrying.
      if (!this.running || this.failures > 0 || this.failure?.state === 'signed-out') return
      this.syncDoc(docId).catch(() => { /* recorded in status */ })
    }, this.o.debounceMs))
  }

  private async runLoop(): Promise<void> {
    if (!this.running) return
    try { await this.syncAll() } catch { /* recorded in status */ }
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.runLoop() }, this.nextDelay())
  }

  private nextDelay(): number {
    if (this.failure?.state === 'signed-out' || this.failures === 0) return this.o.intervalMs
    const exp = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** (this.failures - 1))
    const jittered = exp / 2 + this.o.random() * (exp / 2) // 50%..100%
    return Math.max(jittered, this.retryAfterMs)
  }

  // ---- sync ------------------------------------------------------------

  /** Syncs the workspace first, then every local doc and every doc known to the server. */
  syncAll(): Promise<void> {
    if (this.allRun) return this.allRun
    const run = this.track(async () => {
      const remote = await this.o.api.listDocs()
      const local = new Set(await this.o.storage.listDocIds())
      local.delete(WORKSPACE_DOC_ID)
      const remoteOnly = remote.map((d) => d.docId).filter((id) => id !== WORKSPACE_DOC_ID && !local.has(id))
      let firstErr: unknown = null
      const attempt = async (id: string, fresh: boolean) => {
        try { await this.syncDocInner(id, fresh) } catch (e) {
          if (e instanceof SyncHttpError && (e.isAuth || e.isNetwork || e.isRateLimited)) throw e // pipeline-level
          firstErr ??= e
          this.o.logger?.warn?.(`sync of ${id} failed`, e)
        }
      }
      await attempt(WORKSPACE_DOC_ID, false)
      for (const id of local) await attempt(id, false)
      for (const id of remoteOnly) await attempt(id, true)
      if (firstErr) throw firstErr
    })
    this.allRun = run.finally(() => { this.allRun = null })
    return this.allRun
  }

  syncDoc(docId: string): Promise<void> {
    return this.track(() => this.syncDocInner(docId, false))
  }

  /** Wraps a unit of work with status/backoff bookkeeping. Rethrows failures. */
  private async track(fn: () => Promise<void>): Promise<void> {
    this.active++
    this.publish()
    try {
      await fn()
      this.failure = null
      this.failures = 0
      this.retryAfterMs = 0
      this.status = { ...this.status, lastSyncedAt: this.o.now() }
    } catch (e) {
      this.failures++
      if (e instanceof SyncHttpError) {
        this.retryAfterMs = (e.retryAfter ?? 0) * 1000
        if (e.isAuth) { this.failure = { state: 'signed-out', error: e.message }; this.failures = 0 }
        else if (e.isNetwork) this.failure = { state: 'offline', error: e.message }
        else this.failure = { state: 'error', error: e.message }
      } else {
        this.failure = { state: 'error', error: e instanceof Error ? e.message : String(e) }
      }
      throw e
    } finally {
      this.active--
      this.publish()
    }
  }

  private syncDocInner(docId: string, fresh: boolean): Promise<void> {
    // Serialise per doc: chain behind whatever is queued for this doc.
    const prev = this.chains.get(docId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(() => this.doSync(docId, fresh))
    this.chains.set(docId, next)
    void next.catch(() => {}).finally(() => { if (this.chains.get(docId) === next) this.chains.delete(docId) })
    return next
  }

  private async doSync(docId: string, fresh: boolean): Promise<void> {
    const { api, storage } = this.o
    const doc = await this.o.openDoc(docId)
    if (!doc) return
    const stored = await storage.getSyncState(docId)
    const state: SyncState = stored ?? { docId, pushedVersion: null, pulledSeq: 0 }
    const wasDirty = this.dirty.has(docId)

    // Did the doc hold changes the server has not seen before we pull?
    const versionBefore = doc.version()
    const cleanBefore = fresh || (state.pushedVersion !== null && bytesEqual(versionBefore, state.pushedVersion))

    // ---- pull (paged) ----
    let pulledSeq = state.pulledSeq
    let pulledCount = 0
    let importedAny = false
    for (;;) {
      const res = await api.pull(docId, pulledSeq, this.o.pullLimit)
      let seq = pulledSeq
      if (res.snapshot && res.snapshot.uptoSeq > pulledSeq) {
        doc.importUpdates(res.snapshot.data)
        seq = res.snapshot.uptoSeq
        importedAny = true
      }
      for (const u of res.updates) {
        doc.importUpdates(u.update)
        importedAny = true
        if (u.seq > seq) seq = u.seq
      }
      pulledCount += res.updates.length
      if (seq !== pulledSeq) {
        pulledSeq = seq
        await storage.setSyncState({ docId, pushedVersion: state.pushedVersion, pulledSeq })
        state.pulledSeq = pulledSeq
      }
      if (res.updates.length < this.o.pullLimit) break
    }

    // Everything that was pulled came from the server, so if we had nothing unpushed
    // beforehand the merged version is already "pushed" — no need to echo it back.
    let pushedVersion = state.pushedVersion
    if (cleanBefore && importedAny) pushedVersion = doc.version()

    // ---- push ----
    // Capture the version BEFORE exporting: edits made while the request is in flight
    // stay unpushed and get sent next round.
    const cur = doc.version()
    if (pushedVersion === null || !bytesEqual(cur, pushedVersion)) {
      const bytes = doc.exportUpdates(pushedVersion ?? undefined)
      if (bytes.length > 0) {
        const { seq } = await api.push(docId, this.o.deviceId, bytes)
        // seq === pulledSeq+1: nobody else pushed in between, so nothing to re-pull.
        if (seq === pulledSeq + 1) pulledSeq = seq
      }
      pushedVersion = cur
    }
    await storage.setSyncState({ docId, pushedVersion, pulledSeq })

    if (wasDirty && bytesEqual(doc.version(), cur)) this.dirty.delete(docId)
    else if (wasDirty) { /* edited during sync; stays dirty and the debounced sync will follow */ }
    this.publish()

    if (fresh) this.o.onRemoteDoc?.(docId)

    await this.maybeCompact(docId, doc, pulledSeq, pulledCount)
  }

  private async maybeCompact(docId: string, doc: DocHandle, pulledSeq: number, pulledCount: number): Promise<void> {
    const { storage, api } = this.o
    try {
      const last = (await storage.getSetting<number>(compactedKey(docId))) ?? 0
      // Sequence gap is a good proxy for "updates since last snapshot"; pulledCount alone
      // covers the case where sequence numbers are sparse.
      if (pulledSeq - last <= this.o.compactThreshold && pulledCount <= this.o.compactThreshold) return
      if (pulledSeq <= last) return
      // We have merged everything up to pulledSeq, so our snapshot covers it.
      await api.compact(docId, pulledSeq, doc.exportSnapshot())
      await storage.setSetting(compactedKey(docId), pulledSeq)
    } catch (e) {
      // Compaction is an optimisation; never fail a sync because of it.
      this.o.logger?.warn?.(`compaction of ${docId} failed`, e)
    }
  }
}
