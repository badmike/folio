import { computed, ref, shallowRef } from 'vue'
import { diagnostics } from './diagnostics'
import { runtimeConfig } from './runtime-config'
import { toastError } from './toast'
import { createPasskey, getPasskey, isCancelled } from './webauthn'

export interface AuthUser {
  id: string
  name: string
}

/** A user as folio-server sends it. */
interface UserRes { id: string; name: string | null }

/** `GET /auth/session` of folio-server. */
interface SessionRes {
  available: boolean
  user: UserRes | null
}

/** WebAuthn options from a `.../start` call, with the ceremony id that `.../finish` needs. */
interface CeremonyRes { ceremony: string; options: { publicKey: Record<string, unknown> } }

export interface PasskeyInfo { id: string; createdAt: number; lastUsedAt: number | null }
export interface AccountInfo { passkeys: PasskeyInfo[]; recoveryCodesLeft: number }

/** An invite or admin reset link (`/#invite=<token>`, `/#reset=<token>`) this page was opened with. */
export interface Enrollment { kind: 'invite' | 'reset'; token: string }

/** A request folio-server refused; `message` is its explanation. */
export class AuthError extends Error {}

const DEV_TOKEN_KEY = 'folio.devToken'

function readDevToken(): string | null {
  try { return localStorage.getItem(DEV_TOKEN_KEY) || null } catch { return null }
}

/** Takes an invite or reset token out of the URL, so it is neither bookmarked nor reused. */
function takeEnrollment(): Enrollment | null {
  if (typeof location === 'undefined') return null
  const m = /^#(invite|reset)=([0-9a-f]+)$/.exec(location.hash)
  if (!m) return null
  history.replaceState(history.state, '', location.pathname + location.search)
  return { kind: m[1] as Enrollment['kind'], token: m[2] }
}

const toUser = (u: UserRes): AuthUser => ({ id: u.id, name: u.name || 'Account' })

/**
 * Account handling. Accounts are invite-only and sign in with a passkey; folio-server keeps the
 * session in an HttpOnly cookie, so this asks the server who is signed in. The app is fully
 * usable without an account.
 * For local testing against folio-server with FOLIO_AUTH_DEV, set
 * `localStorage['folio.devToken'] = 'dev:<user-id>'`.
 */
export class AuthService {
  readonly user = shallowRef<AuthUser | null>(null)
  /** The server offers sign-in. False until it has answered, so also when offline or local-only. */
  readonly available = ref(false)
  readonly signedIn = computed(() => !!this.user.value)
  readonly online = ref(typeof navigator === 'undefined' ? true : navigator.onLine !== false)
  /** Set while an invite or reset link waits for its passkey. */
  readonly enrollment = shallowRef<Enrollment | null>(takeEnrollment())
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
    try {
      const res = await fetch(`${apiBase}/auth/session`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { available, user }: SessionRes = await res.json()
      this.available.value = available
      this.user.value = user && toUser(user)
    } catch (e) {
      diagnostics.log('auth.load', e)
    }
  }

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${runtimeConfig.apiBase}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new AuthError(typeof json.message === 'string' ? json.message : `HTTP ${res.status}`)
    return json as T
  }

  /**
   * Runs `fn` and reports failures as a toast. Resolves to undefined when it failed or the
   * person closed the passkey prompt.
   */
  private async attempt<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      if (isCancelled(e)) return undefined
      diagnostics.log(`auth.${what}`, e)
      toastError(e instanceof AuthError ? e.message : 'Something went wrong. Check your connection and try again.')
      return undefined
    }
  }

  /** Sign in with any passkey of this folio server. */
  async signIn(): Promise<boolean> {
    const done = await this.attempt('signIn', async () => {
      const { ceremony, options } = await this.call<CeremonyRes>('POST', '/auth/passkey/login/start')
      const credential = await getPasskey(options)
      return this.call<{ user: UserRes }>('POST', '/auth/passkey/login/finish', { ceremony, credential })
    })
    if (done) this.user.value = toUser(done.user)
    return !!done
  }

  /** Sign in with a recovery code. The code is used up. */
  async recover(code: string): Promise<boolean> {
    const done = await this.attempt('recover', () => this.call<{ user: UserRes }>('POST', '/auth/recover', { code }))
    if (done) this.user.value = toUser(done.user)
    return !!done
  }

  /**
   * Creates the passkey for the pending invite or reset link and signs in. `name` is the new
   * account's name (invites only). Resolves to the account's new recovery codes.
   */
  async enroll(name?: string): Promise<string[] | undefined> {
    const link = this.enrollment.value
    if (!link) return undefined
    const done = await this.attempt('enroll', async () => {
      const start = await this.call<CeremonyRes>('POST', '/auth/passkey/register/start', { token: link.token, name })
      const credential = await createPasskey(start.options)
      return this.call<{ user: UserRes; recoveryCodes: string[] }>('POST', '/auth/passkey/register/finish', { ceremony: start.ceremony, credential })
    })
    if (!done) return undefined
    this.user.value = toUser(done.user)
    this.available.value = true
    return done.recoveryCodes
  }

  /** Adds a passkey (another device or a security key) to the signed-in account. */
  async addPasskey(): Promise<boolean> {
    const done = await this.attempt('addPasskey', async () => {
      const start = await this.call<CeremonyRes>('POST', '/auth/passkey/register/start', {})
      const credential = await createPasskey(start.options)
      return this.call('POST', '/auth/passkey/register/finish', { ceremony: start.ceremony, credential })
    })
    return !!done
  }

  account(): Promise<AccountInfo | undefined> {
    return this.attempt('account', () => this.call<AccountInfo>('GET', '/auth/account'))
  }

  async deletePasskey(id: string): Promise<boolean> {
    return !!(await this.attempt('deletePasskey', () => this.call('DELETE', `/auth/passkeys/${encodeURIComponent(id)}`)))
  }

  /** Replaces the account's recovery codes and resolves to the new ones. */
  async newRecoveryCodes(): Promise<string[] | undefined> {
    const done = await this.attempt('recoveryCodes', () => this.call<{ recoveryCodes: string[] }>('POST', '/auth/recovery-codes'))
    return done?.recoveryCodes
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
