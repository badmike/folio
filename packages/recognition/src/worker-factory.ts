/**
 * Create the recognition worker. Kept in its own module with exactly this URL form so
 * Vite/Rollup can statically detect and bundle the worker entry.
 */
export function createDefaultWorker(): Worker {
  return new Worker(new URL('./recognition.worker.ts', import.meta.url), { type: 'module' })
}
