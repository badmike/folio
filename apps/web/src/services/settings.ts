import type { BackgroundPattern } from '@folio/document'
import type { Storage } from '@folio/persistence'
import type { PenMode, SelectionMode } from '@folio/editor'
import type { VisualTheme } from '@folio/renderer'
import { reactive, watch } from 'vue'

export type CleanupMode = 'keep' | 'auto' | 'ask'
export type DefaultPageType = 'infinite' | 'A4' | 'Letter' | 'iPad'

export interface AppSettings {
  cleanupMode: CleanupMode
  languages: string[]
  cloudRefinement: boolean
  theme: VisualTheme
  penMode: PenMode
  defaultPageType: DefaultPageType
  defaultPattern: BackgroundPattern
  /** New pages get a dark/light background preset matching the app's colour scheme. */
  canvasFollowsTheme: boolean
  /** Zen mode: minimal UI. */
  zen: boolean
  /** Keep shape / arrow / text / frame tools active after creating an object (Excalidraw "Q"). */
  toolLock: boolean
  /** Hide the interface while drawing; only the compact tool options stay. */
  autoHideHud: boolean
  /** Scribbling over ink with the pen erases it. */
  scribbleErase: boolean
  /** Marquee and lasso select objects they touch ('overlap') or only objects fully inside ('wrap'). */
  selectionMode: SelectionMode
  snapToObjects: boolean
  snapToGrid: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  cleanupMode: 'keep',
  languages: ['en', 'de'],
  cloudRefinement: false,
  theme: 'rough',
  penMode: 'auto',
  defaultPageType: 'infinite',
  defaultPattern: 'blank',
  canvasFollowsTheme: true,
  zen: false,
  toolLock: false,
  autoHideHud: false,
  scribbleErase: true,
  selectionMode: 'overlap',
  snapToObjects: false,
  snapToGrid: false,
}

const KEY = 'settings'

/** Reactive, app-wide settings. Persisted via `bindSettings`. */
export const settings = reactive<AppSettings>({ ...DEFAULT_SETTINGS, languages: [...DEFAULT_SETTINGS.languages] })

/** Merge untrusted stored data over the defaults (ignores unknown keys / wrong types). */
export function sanitizeSettings(raw: unknown): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS, languages: [...DEFAULT_SETTINGS.languages] }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d)
  out.cleanupMode = oneOf(r.cleanupMode, ['keep', 'auto', 'ask'], out.cleanupMode)
  out.theme = oneOf(r.theme, ['rough', 'clean'], out.theme)
  out.penMode = oneOf(r.penMode, ['auto', 'pen-only', 'any'], out.penMode)
  out.defaultPageType = oneOf(r.defaultPageType, ['infinite', 'A4', 'Letter', 'iPad'], out.defaultPageType)
  out.defaultPattern = oneOf(r.defaultPattern, ['blank', 'ruled', 'grid', 'dot'], out.defaultPattern)
  if (typeof r.canvasFollowsTheme === 'boolean') out.canvasFollowsTheme = r.canvasFollowsTheme
  if (typeof r.zen === 'boolean') out.zen = r.zen
  if (typeof r.toolLock === 'boolean') out.toolLock = r.toolLock
  if (typeof r.autoHideHud === 'boolean') out.autoHideHud = r.autoHideHud
  if (typeof r.scribbleErase === 'boolean') out.scribbleErase = r.scribbleErase
  out.selectionMode = oneOf(r.selectionMode, ['overlap', 'wrap'], out.selectionMode)
  if (typeof r.snapToObjects === 'boolean') out.snapToObjects = r.snapToObjects
  if (typeof r.snapToGrid === 'boolean') out.snapToGrid = r.snapToGrid
  if (typeof r.cloudRefinement === 'boolean') out.cloudRefinement = r.cloudRefinement
  if (Array.isArray(r.languages)) {
    const langs = r.languages.filter((l): l is string => typeof l === 'string' && /^[a-z]{2,3}$/.test(l))
    if (langs.length) out.languages = langs
  }
  return out
}

/** Load settings from storage into the reactive object and persist future changes. Returns a stop function. */
export async function bindSettings(storage: Storage): Promise<() => void> {
  Object.assign(settings, sanitizeSettings(await storage.getSetting<unknown>(KEY)))
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = watch(settings, () => {
    clearTimeout(timer)
    timer = setTimeout(() => { void storage.setSetting(KEY, JSON.parse(JSON.stringify(settings))) }, 200)
  }, { deep: true })
  return () => { stop(); clearTimeout(timer) }
}

export function toggleZen(on = !settings.zen) { settings.zen = on }
