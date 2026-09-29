import type { NotebookId, Operation } from '@folio/document'
import type { SearchDoc, SearchHit, StoredDoc, SyncState } from './contract'
import { SNIPPET_CLOSE, SNIPPET_OPEN, normalize, searchDocs, tokenize, toFtsQuery } from './text'

/** The subset of `oo1.DB` used here (kept structural so tests/worker can pass any oo1 database). */
export interface SqlDb {
  exec(opts: {
    sql: string
    bind?: unknown[]
    rowMode?: 'object' | 'array'
    returnValue?: 'resultRows'
  }): any
  transaction<T>(callback: () => T): T
}

/** Ordered, append-only list of schema migrations. Index + 1 == schema version. */
export const MIGRATIONS: string[] = [
  `CREATE TABLE docs (
     doc_id TEXT PRIMARY KEY,
     snapshot BLOB,
     snapshot_seq INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE operations (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     doc_id TEXT NOT NULL,
     ops TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX operations_doc ON operations(doc_id, seq);
   CREATE TABLE assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL);
   CREATE TABLE thumbnails (notebook_id TEXT PRIMARY KEY, data_url TEXT NOT NULL);
   CREATE TABLE sync_state (
     doc_id TEXT PRIMARY KEY, pushed_version BLOB, pulled_seq INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
]

const FTS_DDL = `CREATE VIRTUAL TABLE search_index USING fts5(
  notebook_id UNINDEXED, page_id UNINDEXED, object_id UNINDEXED, kind UNINDEXED,
  text, bounds UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`

/** Plain-table replacement when the SQLite build lacks FTS5 (LIKE search on a normalised column). */
const PLAIN_DDL = `CREATE TABLE search_index (
  notebook_id TEXT, page_id TEXT, object_id TEXT, kind TEXT, text TEXT, bounds TEXT, text_norm TEXT);
  CREATE INDEX search_index_nb ON search_index(notebook_id, page_id)`

export interface SqlStoreOptions {
  /** Force the LIKE fallback (tests); default: use FTS5 when available. */
  forceNoFts?: boolean
}

/**
 * All SQL logic, synchronous, over any oo1 database. The worker is a thin RPC wrapper
 * around this class; tests run it in-process on an in-memory database.
 */
export class SqlStore {
  private fts = true

  constructor(private readonly db: SqlDb, private readonly opts: SqlStoreOptions = {}) {}

  get usesFts(): boolean { return this.fts }

  private rows<T = Record<string, any>>(sql: string, bind: unknown[] = []): T[] {
    return this.db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as T[]
  }
  private run(sql: string, bind: unknown[] = []): void {
    this.db.exec({ sql, bind })
  }
  private one<T = Record<string, any>>(sql: string, bind: unknown[] = []): T | undefined {
    return this.rows<T>(sql, bind)[0]
  }

  init(): void {
    this.run('PRAGMA synchronous = FULL')
    this.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
    const cur = this.one<{ version: number }>('SELECT version FROM schema_version')?.version ?? 0
    if (cur > MIGRATIONS.length) {
      throw new Error(`database schema v${cur} is newer than this app supports`)
    }
    for (let v = cur; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec({ sql: MIGRATIONS[v] })
        this.run('DELETE FROM schema_version')
        this.run('INSERT INTO schema_version(version) VALUES (?)', [v + 1])
      })
    }
    this.initSearchTable()
  }

  /** The search table is created outside the numbered migrations because FTS5 may be unavailable. */
  private initSearchTable(): void {
    const exists = this.one("SELECT sql FROM sqlite_master WHERE name = 'search_index'")
    if (exists) {
      this.fts = /fts5/i.test(String(exists.sql))
      return
    }
    if (!this.opts.forceNoFts) {
      try {
        this.run(FTS_DDL)
        this.fts = true
        return
      } catch {
        /* FTS5 not compiled in: fall through to plain table */
      }
    }
    this.db.exec({ sql: PLAIN_DDL })
    this.fts = false
  }

  // --- documents & journal -------------------------------------------------

  loadDoc(docId: string): StoredDoc {
    const d = this.one<{ snapshot: Uint8Array | null; snapshot_seq: number }>(
      'SELECT snapshot, snapshot_seq FROM docs WHERE doc_id = ?', [docId])
    const snapshotSeq = d?.snapshot_seq ?? 0
    const ops = this.rows<{ seq: number; ops: string }>(
      'SELECT seq, ops FROM operations WHERE doc_id = ? AND seq > ? ORDER BY seq', [docId, snapshotSeq])
    return {
      snapshot: d?.snapshot ? new Uint8Array(d.snapshot) : null,
      snapshotSeq,
      pendingOps: ops.map((r) => ({ seq: r.seq, ops: JSON.parse(r.ops) as Operation[] })),
    }
  }

  appendOps(docId: string, ops: Operation[]): number {
    return this.db.transaction(() => {
      this.run('INSERT INTO operations(doc_id, ops, created_at) VALUES (?, ?, ?)',
        [docId, JSON.stringify(ops), Date.now()])
      return Number(this.one<{ s: number }>('SELECT last_insert_rowid() AS s')!.s)
    })
  }

  saveSnapshot(docId: string, snapshot: Uint8Array, upToSeq: number): void {
    this.db.transaction(() => {
      this.run(
        `INSERT INTO docs(doc_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET snapshot = excluded.snapshot,
           snapshot_seq = excluded.snapshot_seq, updated_at = excluded.updated_at`,
        [docId, snapshot, upToSeq, Date.now()])
      this.run('DELETE FROM operations WHERE doc_id = ? AND seq <= ?', [docId, upToSeq])
    })
  }

  deleteDoc(docId: string): void {
    this.db.transaction(() => {
      for (const t of ['docs', 'operations', 'sync_state']) {
        this.run(`DELETE FROM ${t} WHERE doc_id = ?`, [docId])
      }
      this.run('DELETE FROM search_index WHERE notebook_id = ?', [docId])
      this.run('DELETE FROM thumbnails WHERE notebook_id = ?', [docId])
    })
  }

  listDocIds(): string[] {
    return this.rows<{ doc_id: string }>(
      'SELECT doc_id FROM docs UNION SELECT doc_id FROM operations ORDER BY doc_id').map((r) => r.doc_id)
  }

  // --- search --------------------------------------------------------------

  indexNotebook(notebookId: NotebookId, docs: SearchDoc[], pageId?: string): void {
    this.db.transaction(() => {
      if (pageId === undefined) {
        this.run('DELETE FROM search_index WHERE notebook_id = ?', [notebookId])
      } else {
        this.run('DELETE FROM search_index WHERE notebook_id = ? AND page_id = ?', [notebookId, pageId])
      }
      for (const d of docs) {
        const bounds = d.bounds ? JSON.stringify(d.bounds) : null
        if (this.fts) {
          this.run(
            `INSERT INTO search_index(notebook_id, page_id, object_id, kind, text, bounds)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [notebookId, d.pageId, d.objectId, d.kind, d.text, bounds])
        } else {
          this.run(
            `INSERT INTO search_index(notebook_id, page_id, object_id, kind, text, bounds, text_norm)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [notebookId, d.pageId, d.objectId, d.kind, d.text, bounds, normalize(d.text)])
        }
      }
    })
  }

  search(query: string, limit = 50): SearchHit[] {
    if (this.fts) {
      const match = toFtsQuery(query)
      if (!match) return []
      const rows = this.rows(
        `SELECT notebook_id, page_id, object_id, kind, text, bounds,
                snippet(search_index, 4, ?, ?, '…', 12) AS snippet, bm25(search_index) AS score
         FROM search_index WHERE search_index MATCH ? ORDER BY score LIMIT ?`,
        [SNIPPET_OPEN, SNIPPET_CLOSE, match, limit])
      return rows.map((r) => ({ ...toDoc(r), snippet: r.snippet as string, rank: -(r.score as number) }))
    }
    // LIKE fallback: narrow candidates in SQL, then score/snippet with the shared JS matcher.
    const tokens = tokenize(query)
    if (tokens.length === 0) return []
    const where = tokens.map(() => "text_norm LIKE ? ESCAPE '\\'").join(' AND ')
    const rows = this.rows(
      `SELECT notebook_id, page_id, object_id, kind, text, bounds FROM search_index WHERE ${where}`,
      tokens.map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`))
    return searchDocs(rows.map(toDoc), query, limit)
  }

  // --- assets, thumbnails, sync, settings -----------------------------------

  putAsset(id: string, bytes: Uint8Array, mimeType: string): void {
    this.run(
      `INSERT INTO assets(id, mime, bytes) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes`,
      [id, mimeType, bytes])
  }

  getAsset(id: string): { bytes: Uint8Array; mimeType: string } | null {
    const r = this.one<{ mime: string; bytes: Uint8Array | null }>(
      'SELECT mime, bytes FROM assets WHERE id = ?', [id])
    return r ? { bytes: new Uint8Array(r.bytes ?? []), mimeType: r.mime } : null
  }

  getThumbnail(notebookId: NotebookId): string | null {
    return this.one<{ data_url: string }>(
      'SELECT data_url FROM thumbnails WHERE notebook_id = ?', [notebookId])?.data_url ?? null
  }

  setThumbnail(notebookId: NotebookId, dataUrl: string): void {
    this.run(
      `INSERT INTO thumbnails(notebook_id, data_url) VALUES (?, ?)
       ON CONFLICT(notebook_id) DO UPDATE SET data_url = excluded.data_url`, [notebookId, dataUrl])
  }

  getSyncState(docId: string): SyncState | null {
    const r = this.one<{ pushed_version: Uint8Array | null; pulled_seq: number }>(
      'SELECT pushed_version, pulled_seq FROM sync_state WHERE doc_id = ?', [docId])
    return r
      ? { docId, pushedVersion: r.pushed_version ? new Uint8Array(r.pushed_version) : null, pulledSeq: r.pulled_seq }
      : null
  }

  setSyncState(s: SyncState): void {
    this.run(
      `INSERT INTO sync_state(doc_id, pushed_version, pulled_seq) VALUES (?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET pushed_version = excluded.pushed_version,
         pulled_seq = excluded.pulled_seq`,
      [s.docId, s.pushedVersion, s.pulledSeq])
  }

  getSetting(key: string): unknown {
    const r = this.one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
    return r ? JSON.parse(r.value) : undefined
  }

  setSetting(key: string, value: unknown): void {
    this.run(
      `INSERT INTO settings(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, JSON.stringify(value === undefined ? null : value)])
  }
}

function toDoc(r: Record<string, any>): SearchDoc {
  const doc: SearchDoc = {
    notebookId: r.notebook_id, pageId: r.page_id ?? null, objectId: r.object_id ?? null,
    kind: r.kind, text: r.text,
  }
  if (r.bounds) doc.bounds = JSON.parse(r.bounds)
  return doc
}

/** RPC method names the worker exposes (whitelist). */
export const RPC_METHODS = [
  'init', 'loadDoc', 'appendOps', 'saveSnapshot', 'deleteDoc', 'listDocIds', 'indexNotebook', 'search',
  'putAsset', 'getAsset', 'getThumbnail', 'setThumbnail', 'getSyncState', 'setSyncState',
  'getSetting', 'setSetting',
] as const
export type RpcMethod = (typeof RPC_METHODS)[number]
