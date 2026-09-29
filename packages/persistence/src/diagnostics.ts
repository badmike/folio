export interface DiagnosticEntry {
  time: string
  source: string
  message: string
  /** Small, non-content context (doc ids, phase names, counts). */
  context?: Record<string, string | number | boolean | null>
}

export interface Diagnostics {
  log(source: string, error: unknown, context?: DiagnosticEntry['context']): void
  entries(): DiagnosticEntry[]
  /** JSON string suitable for a "copy diagnostics" button. */
  exportJson(): string
  clear(): void
}

/** Ring buffer of recent errors. Never records notebook content, only error messages/context. */
export function createDiagnostics(maxEntries = 100): Diagnostics {
  let list: DiagnosticEntry[] = []
  return {
    log(source, error, context) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      list.push({ time: new Date().toISOString(), source, message: message.slice(0, 500), context })
      if (list.length > maxEntries) list = list.slice(-maxEntries)
    },
    entries: () => [...list],
    exportJson: () => JSON.stringify({ exportedAt: new Date().toISOString(), entries: list }, null, 2),
    clear() { list = [] },
  }
}
