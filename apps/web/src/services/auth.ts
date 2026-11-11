import { computed, ref, shallowRef } from 'vue'
import { diagnostics } from './diagnostics'
import { runtimeConfig } from './runtime-config'
import { toastError } from './toast'

export interface AuthUser {
  id: string
  name: string
  email?: string
  imageUrl?: string
}

/** `GET /auth/session` of folio-server. */
interface SessionRes {
  available: boolean
  user: { id: string; name: string | null; email: string | null; picture: string | null } | null
}

const DEV_TOKEN_KEY = 'folio.devToken'

function readDevToken(): string | null {
  try { return localStorage.getItem(DEV_TOKEN_KEY) || null } catch { return null }
}

/** The server sends the browser back with `?signin=failed` when a sign-in did not complete. */
function takeSignInFailure(): boolean {
  const url = new URL(location.href)
  if (url.searchParams.get('signin') !== 'failed') return false
  url.searchParams.delete('signin')
  history.replaceState(history.state, '', url)
  return true
}

/**
 * Account handling. folio-server signs people in through its OpenID Connect provider and keeps
 * the session in an HttpOnly cookie, so this only asks the server who is signed in. The app is
 * fully usable without an account.
 * For local testing against folio-server with FOLIO_AUTH_DEV, set
 * `localStorage['folio.devToken'] = 'dev:<user-id>'`.
 */
export class AuthService {
  readonly user = shallowRef<AuthUser | null>(null)
  /** The server offers sign-in. False until it has answered, so also when offline or local-only. */
  readonly available = ref(false)
  readonly signedIn = computed(() => !!this.user.value)
  readonly online = ref(typeof navigator === 'undefined' ? true : navigator.onLine !== false)
  private devToken: string | null

  constructor() {
    this.devToken = readDevToken()
    if (this.devToken) this.user.value = { id: this.devToken, name: 'Dev user' }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.online.value = true; void this.load() })
      window.addEventListener('offline', () => { this.online.value = false })
    }
  }

  get isDevToken(): boolean { return !!this.devToken }

  /**
   * Token source for API clients that send `Authorization` themselves. Undefined when the
   * session cookie authenticates their requests.
   */
  get bearer(): (() => Promise<string | null>) | undefined {
    return this.devToken ? () => this.getToken() : undefined
  }

  /** Ask the server who is signed in. A failure (e.g. offline) keeps the current state. */
  async load(): Promise<void> {
    const { apiBase } = runtimeConfig
    if (!apiBase || this.devToken) return
    if (takeSignInFailure()) toastError('Sign-in did not complete. Please try again.')
    try {
      const res = await fetch(`${apiBase}/auth/session`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { available, user }: SessionRes = await res.json()
      this.available.value = available
      this.user.value = user && {
        id: user.id,
        name: user.name || user.email || 'Account',
        email: user.email ?? undefined,
        imageUrl: user.picture ?? undefined,
      }
    } catch (e) {
      diagnostics.log('auth.load', e)
    }
  }

  signIn(): void {
    location.assign(`${runtimeConfig.apiBase}/auth/login`)
  }

  async signOut(): Promise<void> {
    if (this.devToken) {
      try { localStorage.removeItem(DEV_TOKEN_KEY) } catch { /* ignore */ }
      this.devToken = null
      this.user.value = null
      return
    }
    try {
      const res = await fetch(`${runtimeConfig.apiBase}/auth/logout`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.user.value = null
    } catch (e) {
      diagnostics.log('auth.signOut', e)
      toastError('Could not sign out. Check your connection and try again.')
    }
  }

  /** The dev token, if one is set. Signed-in browsers authenticate with their cookie instead. */
  async getToken(): Promise<string | null> {
    return this.devToken
  }
}
