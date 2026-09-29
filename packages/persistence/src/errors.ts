/** Thrown by `SqliteStorage.init()` when another tab/window already owns the OPFS database. */
export class StorageLockedError extends Error {
  override name = 'StorageLockedError'
  constructor(message = 'folio is already open in another tab or window') {
    super(message)
  }
}

/** Thrown when the storage backend cannot be used at all (no OPFS, worker crash, ...). */
export class StorageUnavailableError extends Error {
  override name = 'StorageUnavailableError'
}
