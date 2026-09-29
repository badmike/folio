export * from './contract'
export * from './errors'
export * from './diagnostics'
export { MemoryStorage, createMemoryState, type MemoryState } from './memory-storage'
export { IdbStorage } from './idb-storage'
export {
  SqliteStorage, inProcessTransport, acquireStorageLock,
  type SqlTransport, type SqliteStorageOptions,
} from './sqlite-storage'
export { SqlStore, MIGRATIONS, type SqlDb } from './sql-store'
export { openStorage, type OpenStorageOptions, type OpenedStorage } from './open-storage'
export {
  DocPersister, type PersistableDoc, type DocFactory, type DocPersisterOptions, type PersisterErrorInfo,
} from './doc-persister'
export { SNIPPET_OPEN, SNIPPET_CLOSE, normalize as normalizeSearchText } from './text'
