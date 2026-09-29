import { createDiagnostics } from '@folio/persistence'

/** App-wide ring buffer of recent errors (never contains notebook content). */
export const diagnostics = createDiagnostics(200)

let installed = false
/** Log uncaught errors / unhandled rejections to diagnostics. */
export function installGlobalErrorHandlers(target: Pick<Window, 'addEventListener'> = window): void {
  if (installed) return
  installed = true
  target.addEventListener('error', (e) => {
    const ev = e as ErrorEvent
    diagnostics.log('window.error', ev.error ?? ev.message)
  })
  target.addEventListener('unhandledrejection', (e) => {
    diagnostics.log('unhandledrejection', (e as PromiseRejectionEvent).reason)
  })
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 1000)
}

export function exportDiagnostics(extra: Record<string, unknown> = {}): void {
  const json = JSON.stringify({ ...JSON.parse(diagnostics.exportJson()), app: 'folio', ua: navigator.userAgent, ...extra }, null, 2)
  downloadBlob(new Blob([json], { type: 'application/json' }), 'folio-diagnostics.json')
}
