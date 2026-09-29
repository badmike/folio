import { computed, ref, shallowRef } from 'vue'
import { diagnostics } from './diagnostics'

export interface AuthUser {
  id: string
  name: string
  email?: string
  imageUrl?: string
}

/** Minimal shape of the parts of Clerk we use. */
interface ClerkLike {
  load(opts?: Record<string, unknown>): Promise<void>
  openSignIn(opts?: Record<string, unknown>): void
  openUserProfile?(): void
  signOut(): Promise<void>
  user?: { id: string; fullName?: string | null; username?: string | null; primaryEmailAddress?: { emailAddress: string } | null; imageUrl?: string } | null
  session?: { getToken(): Promise<string | null> } | null
  addListener(cb: () => void): () => void
}

declare global {
  interface Window { Clerk?: ClerkLike }
}

/** Clerk publishable keys are `pk_<env>_<base64(frontendApi + '$')>`. */
export function clerkFrontendApi(publishableKey: string): string | null {
  const payload = publishableKey.split('_')[2]
  if (!payload) return null
  try {
    return atob(payload).replace(/\$+$/, '') || null
  } catch {
    return null
  }
}

const DEV_TOKEN_KEY = 'folio.devToken'

function readDevToken(): string | null {
  try { return localStorage.getItem(DEV_TOKEN_KEY) || null } catch { return null }
}

/**
 * Account handling. Clerk is loaded at runtime from its CDN (no npm dependency) and only
 * when VITE_CLERK_PUBLISHABLE_KEY is set. The app is fully usable without an account.
 * For local testing against folio-server with FOLIO_AUTH_DEV, set
 * `localStorage['folio.devToken'] = 'dev:<user-id>'`.
 */
export class AuthService {
  readonly user = shallowRef<AuthUser | null>(null)
  /** Clerk finished loading (false when not configured or offline). */
  readonly ready = ref(false)
  readonly configured: boolean
  readonly signedIn = computed(() => !!this.user.value)
  readonly online = ref(typeof navigator === 'undefined' ? true : navigator.onLine !== false)
  private devToken: string | null

  constructor(private readonly publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '') {
    this.devToken = readDevToken()
    this.configured = !!this.publishableKey && !!clerkFrontendApi(this.publishableKey)
    if (this.devToken) this.user.value = { id: this.devToken, name: 'Dev user' }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.online.value = true; void this.load() })
      window.addEventListener('offline', () => { this.online.value = false })
    }
  }

  get isDevToken(): boolean { return !!this.devToken }

  /** Load Clerk (idempotent, failures are non-fatal: e.g. offline). */
  async load(): Promise<void> {
    if (this.ready.value || !this.configured || this.devToken) return
    try {
      if (!window.Clerk) await this.injectScript()
      const clerk = window.Clerk
      if (!clerk) return
      await clerk.load()
      const sync = () => {
        const u = clerk.user
        this.user.value = u
          ? { id: u.id, name: u.fullName || u.username || u.primaryEmailAddress?.emailAddress || 'Account', email: u.primaryEmailAddress?.emailAddress, imageUrl: u.imageUrl }
          : null
      }
      sync()
      clerk.addListener(sync)
      this.ready.value = true
    } catch (e) {
      diagnostics.log('auth.load', e)
    }
  }

  private injectScript(): Promise<void> {
    const api = clerkFrontendApi(this.publishableKey)
    return new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = `https://${api}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`
      s.async = true
      s.crossOrigin = 'anonymous'
      s.setAttribute('data-clerk-publishable-key', this.publishableKey)
      s.onload = () => resolve()
      s.onerror = () => { s.remove(); reject(new Error('Clerk script failed to load')) }
      document.head.appendChild(s)
    })
  }

  signIn(): void {
    if (window.Clerk) window.Clerk.openSignIn()
    else void this.load().then(() => window.Clerk?.openSignIn())
  }

  openProfile(): void { window.Clerk?.openUserProfile?.() }

  async signOut(): Promise<void> {
    if (this.devToken) {
      try { localStorage.removeItem(DEV_TOKEN_KEY) } catch { /* ignore */ }
      this.devToken = null
      this.user.value = null
      return
    }
    await window.Clerk?.signOut()
    this.user.value = null
  }

  async getToken(): Promise<string | null> {
    if (this.devToken) return this.devToken
    try { return (await window.Clerk?.session?.getToken()) ?? null } catch (e) {
      diagnostics.log('auth.token', e)
      return null
    }
  }
}
