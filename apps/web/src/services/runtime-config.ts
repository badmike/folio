/**
 * Deployment config read at boot from `config.json` next to index.html, so one build works
 * against any folio server. folio-server generates the file from its env; static hosts edit
 * it by hand. Build-time `VITE_*` values are the fallback (dev server, tests).
 */
export interface RuntimeConfig {
  /** Base URL of folio-server (e.g. `/api`). Empty = local only. */
  apiBase: string
  /** Clerk publishable key. Empty = no accounts. */
  clerkPublishableKey: string
}

const CACHE_KEY = 'folio.runtimeConfig'

const clean = (c: RuntimeConfig): RuntimeConfig => ({
  apiBase: c.apiBase.trim().replace(/\/+$/, ''),
  clerkPublishableKey: c.clerkPublishableKey.trim(),
})

/** Current config. Read it at use time: `loadRuntimeConfig()` replaces the values during boot. */
export const runtimeConfig: RuntimeConfig = clean({
  apiBase: import.meta.env.VITE_API_BASE ?? '',
  clerkPublishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '',
})

function parse(value: unknown): RuntimeConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const { apiBase, clerkPublishableKey } = value as Partial<Record<keyof RuntimeConfig, unknown>>
  return clean({
    apiBase: typeof apiBase === 'string' ? apiBase : '',
    clerkPublishableKey: typeof clerkPublishableKey === 'string' ? clerkPublishableKey : '',
  })
}

function readCache(): RuntimeConfig | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? parse(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

/**
 * Network first, last good copy when offline. A missing or invalid file (e.g. a static host
 * answering with index.html) keeps the build-time values.
 */
export async function loadRuntimeConfig(): Promise<void> {
  let loaded: RuntimeConfig | null
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store' })
    loaded = res.ok ? parse(await res.json().catch(() => null)) : null
    try {
      if (loaded) localStorage.setItem(CACHE_KEY, JSON.stringify(loaded))
      else localStorage.removeItem(CACHE_KEY)
    } catch { /* storage unavailable: still use what we fetched */ }
  } catch {
    loaded = readCache()
  }
  if (loaded) Object.assign(runtimeConfig, loaded)
}
