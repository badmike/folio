import type { ChangeOrigin, Operation } from '@folio/document'
import type { Storage } from './contract'

/** Structural subset of NotebookDocumentApi / WorkspaceDocumentApi needed for persistence. */
export interface PersistableDoc {
  exportSnapshot(): Uint8Array
  /** Notebook docs. Omit for docs that have no operation journal (workspace doc). */
  apply?(ops: Operation[], origin?: 'local' | 'journal'): void
  subscribe(listener: (e: { origin: ChangeOrigin } | ChangeOrigin) => void): () => void
}

export interface DocFactory<D extends PersistableDoc> {
  fromSnapshot(bytes: Uint8Array): D
  empty(docId: string): D
}

export interface PersisterErrorInfo {
  phase: 'replay' | 'append' | 'snapshot' | 'load' | 'quarantine'
  docId: string
}

export interface DocPersisterOptions {
  /** Snapshot after this many recorded batches. Default 30. */
  snapshotEveryOps?: number
  /** Snapshot after this long without new records. Default 5000 ms. */
  idleMs?: number
  /** Delay before snapshotting after a remote change. Default 1000 ms. */
  remoteDelayMs?: number
  onError?: (error: unknown, info: PersisterErrorInfo) => void
  /** Hook pagehide / visibilitychange when a DOM is present. Default true. */
  listenToPageEvents?: boolean
}

/**
 * Durability for one open document: crash-safe journal + debounced snapshot compaction.
 *
 * Editor usage: `doc.apply(ops); persister.record(ops)`. `record` resolves once the ops
 * are durable in the journal. Everything runs on one serial queue so journal order equals
 * apply order and a snapshot never races an append.
 */
export class DocPersister<D extends PersistableDoc = PersistableDoc> {
  private doc: D | null = null
  private docId = ''
  private lastSeq = 0
  private recordsSinceSnapshot = 0
  private dirty = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsub: (() => void) | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private readonly o: Required<Omit<DocPersisterOptions, 'onError'>> & Pick<DocPersisterOptions, 'onError'>
  private readonly onPageEvent = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') return
    void this.flush()
  }

  constructor(private readonly storage: Storage, opts: DocPersisterOptions = {}) {
    this.o = {
      snapshotEveryOps: opts.snapshotEveryOps ?? 30,
      idleMs: opts.idleMs ?? 5000,
      remoteDelayMs: opts.remoteDelayMs ?? 1000,
      listenToPageEvents: opts.listenToPageEvents ?? true,
      onError: opts.onError,
    }
  }

  private fail(error: unknown, phase: PersisterErrorInfo['phase']) {
    try { this.o.onError?.(error, { phase, docId: this.docId }) } catch { /* diagnostics must not throw */ }
  }

  /** Load snapshot (or `empty`), replay the pending journal with origin 'journal', start tracking. */
  async load(docId: string, factory: DocFactory<D>): Promise<D> {
    this.docId = docId
    const stored = await this.storage.loadDoc(docId)
    const doc = stored.snapshot ? factory.fromSnapshot(stored.snapshot) : factory.empty(docId)
    this.lastSeq = stored.snapshotSeq
    const failed: { seq: number; op: Operation }[] = []

    for (const entry of stored.pendingOps) {
      this.lastSeq = Math.max(this.lastSeq, entry.seq)
      if (!doc.apply) break
      try {
        doc.apply(entry.ops, 'journal')
      } catch (e) {
        this.fail(e, 'replay')
        // The batch is atomic; retry op-by-op so one bad op cannot discard its neighbours.
        for (const op of entry.ops) {
          try { doc.apply([op], 'journal') } catch (e2) {
            this.fail(e2, 'replay')
            failed.push({ seq: entry.seq, op })
          }
        }
      }
    }
    if (failed.length) {
      // Keep failed ops around before compaction removes them from the journal.
      try {
        const key = `quarantine:${docId}`
        const prev = (await this.storage.getSetting<unknown[]>(key)) ?? []
        await this.storage.setSetting(key, [...prev, ...failed])
      } catch (e) { this.fail(e, 'quarantine') }
    }
    this.doc = doc
    this.unsub = doc.subscribe((e) => {
      const origin = typeof e === 'string' ? e : e.origin
      if (origin === 'remote') this.markDirty(this.o.remoteDelayMs)
    })
    this.attachPageEvents()
    // Fold replayed journal into a fresh snapshot soon (compacts and heals).
    if (stored.pendingOps.length) this.markDirty(this.o.remoteDelayMs)
    return doc
  }

  /** Append `ops` to the journal. Resolves with the journal seq (or null if it failed; see onError). */
  record(ops: Operation[]): Promise<number | null> {
    if (ops.length === 0) return Promise.resolve(null)
    const p = this.chain.then(async () => {
      try {
        const seq = await this.storage.appendOps(this.docId, ops)
        this.lastSeq = Math.max(this.lastSeq, seq)
        return seq
      } catch (e) {
        this.fail(e, 'append')
        this.dirty = true // the doc has the change even though the journal doesn't: snapshot it
        return null
      }
    })
    this.chain = p
    this.dirty = true
    this.recordsSinceSnapshot++
    if (this.recordsSinceSnapshot >= this.o.snapshotEveryOps) void this.snapshotNow()
    else this.schedule(this.o.idleMs)
    return p
  }

  /** Persist everything now: drains the journal queue and writes a snapshot if anything changed. */
  async flush(): Promise<void> {
    this.clearTimer()
    await this.snapshotNow()
  }

  /** Flush and detach all listeners. The persister cannot be reused. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    await this.flush().catch(() => {})
    this.disposed = true
    this.unsub?.()
    this.unsub = null
    this.detachPageEvents()
    this.clearTimer()
  }

  // --- internals -------------------------------------------------------------

  private markDirty(delayMs: number) {
    this.dirty = true
    this.schedule(delayMs)
  }

  private schedule(delayMs: number) {
    if (this.disposed) return
    this.clearTimer()
    this.timer = setTimeout(() => { this.timer = null; void this.snapshotNow() }, delayMs)
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private snapshotNow(): Promise<void> {
    this.clearTimer()
    const p = this.chain.then(async () => {
      if (!this.dirty || !this.doc) return
      // Journaled ops <= upToSeq are already applied to the doc (apply precedes record),
      // so the exported snapshot covers them. Ops applied but not yet journaled are just
      // replayed once more after a crash, which the CRDT tolerates.
      const upToSeq = this.lastSeq
      this.dirty = false
      this.recordsSinceSnapshot = 0
      try {
        await this.storage.saveSnapshot(this.docId, this.doc.exportSnapshot(), upToSeq)
      } catch (e) {
        this.dirty = true
        this.fail(e, 'snapshot')
      }
    })
    this.chain = p
    return p
  }

  private attachPageEvents() {
    if (!this.o.listenToPageEvents) return
    if (typeof addEventListener === 'function') addEventListener('pagehide', this.onPageEvent)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onPageEvent)
  }
  private detachPageEvents() {
    if (typeof removeEventListener === 'function') removeEventListener('pagehide', this.onPageEvent)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onPageEvent)
  }
}
