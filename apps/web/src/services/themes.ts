import {
  defaultBackground, isDarkColor, isThemeId, resolveTheme, themeLineColor, themePaper,
  type BackgroundPattern, type NotebookMeta, type PageBackground, type ResolvedTheme, type ThemeId, type ThemeOverrides, type WorkspaceDocumentApi,
} from '@folio/document'
import { shallowRef } from 'vue'
import { settings } from './settings'

/** Per-theme customisations from the synced workspace document (kept current by bindThemes). */
export const themeOverrides = shallowRef<Partial<Record<ThemeId, ThemeOverrides>>>({})

/** Mirror the workspace's theme customisations into `themeOverrides`. Returns a stop function. */
export function bindThemes(ws: WorkspaceDocumentApi): () => void {
  const read = () => {
    const next = ws.themeOverrides()
    if (JSON.stringify(next) !== JSON.stringify(themeOverrides.value)) themeOverrides.value = next
  }
  read()
  return ws.subscribe(read)
}

/** A theme with the user's customisations. */
export function themeFor(id: ThemeId): ResolvedTheme {
  return resolveTheme(id, themeOverrides.value[id])
}

/** The theme a notebook shows: its own, or the device default when it never picked one. */
export function notebookThemeId(meta: Pick<NotebookMeta, 'theme'>): ThemeId {
  return isThemeId(meta.theme) ? meta.theme : settings.defaultTheme
}

/** New pages are dark when the canvas follows a dark app scheme. */
export function prefersDarkCanvas(): boolean {
  const dark = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
  return settings.canvasFollowsTheme && dark
}

/** Background of a new page: the theme's paper for the app's light or dark scheme. */
export function themedBackground(pattern: BackgroundPattern, theme: ResolvedTheme): PageBackground {
  const bg = defaultBackground(pattern)
  const color = themePaper(theme, prefersDarkCanvas())
  // white paper keeps the stock line colour, as before themes existed
  return color === bg.color ? bg : { ...bg, color, lineColor: themeLineColor(theme, color) }
}

/** A page background repainted with the theme's paper, keeping its pattern and its light or dark scheme. */
export function repaintedBackground(bg: PageBackground, theme: ResolvedTheme): PageBackground {
  const color = themePaper(theme, isDarkColor(bg.color))
  return { ...bg, color, lineColor: themeLineColor(theme, color) }
}
