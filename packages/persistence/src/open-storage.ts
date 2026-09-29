import type { Storage } from './contract'
import type { Diagnostics } from './diagnostics'
import { StorageLockedError } from './errors'
import { IdbStorage } from './idb-storage'
import { MemoryStorage } from './memory-storage'
import { SqliteStorage } from './sqlite-storage'

export interface OpenStorageOptions {
  /** Restrict/skip backends (mostly for tests). Default: all, in order sqlite -> idb -> memory. */
  backends?: Storage['kind'][]
  idbName?: string
  diagnostics?: Diagnostics
  /** Ask the browser for persistent storage (best effort). Default true. */
  requestPersistence?: boolean
}

export interface OpenedStorage {
  storage: Storage
  kind: Storage['kind']
  /** Result of navigator.storage.persist(), or null when not asked/unsupported. */
  persisted: boolean | null
}

function hasOpfs(): boolean {
  return typeof Worker !== 'undefined' &&
    typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
}

/**
 * Open the best available storage. Rejects with StorageLockedError (no fallback!) when
 * another tab owns the SQLite database — falling back would silently fork the user's data.
 */
export async function openStorage(opts: OpenStorageOptions = {}): Promise<OpenedStorage> {
  const allowed = opts.backends ?? ['sqlite-opfs', 'indexeddb', 'memory']
  let persisted: boolean | null = null
  if (opts.requestPersistence !== false) {
    try { persisted = (await navigator.storage?.persist?.()) ?? null } catch { /* best effort */ }
  }
  const done = (storage: Storage): OpenedStorage => ({ storage, kind: storage.kind, persisted })

  if (allowed.includes('sqlite-opfs') && hasOpfs()) {
    const s = new SqliteStorage()
    try {
      await s.init()
      return done(s)
    } catch (e) {
      if (e instanceof StorageLockedError) throw e
      s.close()
      opts.diagnostics?.log('openStorage.sqlite', e)
    }
  }
  if (allowed.includes('indexeddb') && typeof indexedDB !== 'undefined') {
    const s = new IdbStorage(opts.idbName)
    try {
      await s.init()
      return done(s)
    } catch (e) {
      opts.diagnostics?.log('openStorage.idb', e)
    }
  }
  const m = new MemoryStorage()
  await m.init()
  return done(m)
}
