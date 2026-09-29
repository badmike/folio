import { resetTextMetrics } from '@folio/renderer'

let ready: Promise<void> | null = null

/**
 * Resolves once Caveat is loaded and the renderer's cached text metrics were reset.
 * Callers should then invalidate their renderer (e.g. `editor.setTheme(editor.theme)`).
 */
export function whenFontsReady(): Promise<void> {
  ready ??= (async () => {
    try {
      if (typeof document !== 'undefined' && document.fonts) {
        await Promise.all([document.fonts.load('400 20px Caveat'), document.fonts.load('700 20px Caveat')])
        await document.fonts.ready
      }
    } catch { /* fonts are optional; fall back to system cursive */ }
    resetTextMetrics()
  })()
  return ready
}
