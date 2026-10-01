import { WEB_FONT_NAMES, resetTextMetrics } from '@folio/renderer'

let ready: Promise<void> | null = null

/**
 * Resolves once the bundled web fonts (Excalifont and the other hand-drawn faces, Fira Code) are
 * loaded and the renderer's cached text metrics were reset. Callers should then invalidate
 * their renderer (e.g. `editor.setTheme(editor.theme)`).
 */
export function whenFontsReady(): Promise<void> {
  ready ??= (async () => {
    try {
      if (typeof document !== 'undefined' && document.fonts) {
        await Promise.allSettled([
          document.fonts.load('700 20px Caveat'),
          ...WEB_FONT_NAMES.map((f) => document.fonts.load(`400 20px '${f}'`)),
        ])
        await document.fonts.ready
      }
    } catch { /* fonts are optional; fall back to system fonts */ }
    resetTextMetrics()
  })()
  return ready
}
