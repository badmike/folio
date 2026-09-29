import 'fake-indexeddb/auto'
import { afterAll, describe, expect, it } from 'vitest'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { IDBFactory } from 'fake-indexeddb'
import { IdbStorage } from '../src/idb-storage'
import { createMemoryState, MemoryStorage } from '../src/memory-storage'
import { inProcessTransport, SqliteStorage, acquireStorageLock } from '../src/sqlite-storage'
import { SqlStore, MIGRATIONS, type SqlDb } from '../src/sql-store'
import { StorageLockedError } from '../src/errors'
import { storageConformance } from './conformance'

storageConformance('MemoryStorage', () => {
  const state = createMemoryState()
  return { open: async () => { const s = new MemoryStorage(state); await s.init(); return s } }
})

let n = 0
storageConformance('IdbStorage', () => {
  const idb = new IDBFactory()
  ;(globalThis as any).indexedDB = idb
  const name = `t${n++}`
  return { open: async () => { const s = new IdbStorage(name); await s.init(); return s } }
})

const sqlite3 = await sqlite3InitModule()
function sqliteBacking(forceNoFts: boolean) {
  return () => {
    const db = new sqlite3.oo1.DB(':memory:')
    return {
      open: async () => {
        const s = new SqliteStorage({
          connect: async () => inProcessTransport(new SqlStore(db as unknown as SqlDb, { forceNoFts })),
        })
        await s.init()
        return s
      },
    }
  }
}
storageConformance('SqliteStorage (FTS5)', sqliteBacking(false))
storageConformance('SqliteStorage (LIKE fallback)', sqliteBacking(true))

describe('SqlStore specifics', () => {
  it('uses FTS5 with unicode61 tokenizer and runs migrations idempotently', () => {
    const db = new sqlite3.oo1.DB(':memory:')
    const store = new SqlStore(db as unknown as SqlDb)
    store.init()
    store.init()
    expect(store.usesFts).toBe(true)
    expect(db.selectValue('SELECT version FROM schema_version')).toBe(MIGRATIONS.length)
    expect(String(db.selectValue("SELECT sql FROM sqlite_master WHERE name='search_index'"))).toContain('remove_diacritics 2')
    const fb = new SqlStore(new sqlite3.oo1.DB(':memory:') as unknown as SqlDb, { forceNoFts: true })
    fb.init()
    expect(fb.usesFts).toBe(false)
  })

  it('rolls back a failed transaction (no partial journal writes)', () => {
    const db = new sqlite3.oo1.DB(':memory:')
    const store = new SqlStore(db as unknown as SqlDb)
    store.init()
    expect(() => store.indexNotebook('nb', [{ notebookId: 'nb', pageId: null, objectId: null, kind: 'text', text: 'keep' }, null as never]))
      .toThrow()
    expect(store.search('keep')).toEqual([])
  })
})

describe('acquireStorageLock', () => {
  it('rejects with StorageLockedError when another holder exists', async () => {
    const held = new Set<string>()
    const fake = {
      request(name: string, _o: unknown, cb: (l: unknown) => unknown) {
        if (held.has(name)) return Promise.resolve(cb(null))
        held.add(name)
        return Promise.resolve(cb({ name })).finally(() => held.delete(name))
      },
    }
    Object.defineProperty(globalThis, 'navigator', { value: { locks: fake }, configurable: true })
    const release = await acquireStorageLock('x')
    await expect(acquireStorageLock('x')).rejects.toBeInstanceOf(StorageLockedError)
    release()
    await new Promise((r) => setTimeout(r, 0))
    const again = await acquireStorageLock('x')
    again()
  })
})
afterAll(() => { /* in-memory dbs are garbage collected */ })
void expect
