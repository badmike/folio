/// <reference lib="webworker" />
// Dedicated worker owning the SQLite database (opfs-sahpool VFS). Thin RPC shell around SqlStore.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { RPC_METHODS, SqlStore, type RpcMethod, type SqlDb } from './sql-store'
import type { RpcRequest, RpcResponse } from './sqlite-storage'

const DB_FILE = '/folio.sqlite3'
let store: SqlStore | null = null

async function open(): Promise<SqlStore> {
  const sqlite3 = await sqlite3InitModule()
  // sahpool needs exclusive access to its OPFS directory; a second tab fails here.
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: 'folio-sahpool', directory: '/folio-sahpool', initialCapacity: 6,
  })
  const db = new pool.OpfsSAHPoolDb(DB_FILE)
  const s = new SqlStore(db as unknown as SqlDb)
  s.init()
  return s
}

/** Collect transferable buffers of Uint8Array results. */
function transferables(v: unknown): Transferable[] {
  const out: Transferable[] = []
  const visit = (x: unknown): void => {
    if (x instanceof Uint8Array) {
      if (x.byteOffset === 0 && x.byteLength === x.buffer.byteLength && x.buffer instanceof ArrayBuffer) out.push(x.buffer)
    } else if (Array.isArray(x)) x.forEach(visit)
    else if (x && typeof x === 'object') Object.values(x).forEach(visit)
  }
  visit(v)
  return out
}

self.onmessage = async (ev: MessageEvent<RpcRequest>) => {
  const { id, method, args } = ev.data
  let res: RpcResponse
  let transfer: Transferable[] = []
  try {
    if (!(RPC_METHODS as readonly string[]).includes(method)) throw new Error(`unknown method ${method}`)
    let result: unknown
    if (method === 'init') {
      if (!store) store = await open()
      result = { fts: store.usesFts }
    } else {
      if (!store) throw new Error('storage not initialised')
      result = (store[method as Exclude<RpcMethod, 'init'>] as (...a: unknown[]) => unknown)(...args)
    }
    res = { id, ok: true, result }
    transfer = transferables(result)
  } catch (e) {
    const err = e as Error
    res = { id, ok: false, error: { name: err?.name ?? 'Error', message: String(err?.message ?? e) } }
  }
  ;(self as unknown as Worker).postMessage(res, transfer)
}
