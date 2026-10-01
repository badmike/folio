import { base64ToBytes, bytesToBase64 } from './base64'

export interface PulledUpdate { seq: number; update: Uint8Array }
export interface PullResult {
  updates: PulledUpdate[]
  latestSeq: number
  snapshot?: { uptoSeq: number; data: Uint8Array }
}
export interface RemoteDocInfo { docId: string; latestSeq: number; updatedAt: string | number }

/** HTTP-level failure. `status` 0 means the request never got a response (offline / DNS / CORS). */
export class SyncHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Seconds from Retry-After, if the server sent one. */
    public readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'SyncHttpError'
  }
  get isAuth(): boolean { return this.status === 401 }
  get isRateLimited(): boolean { return this.status === 429 }
  get isNetwork(): boolean { return this.status === 0 }
}

export interface SyncApiOptions {
  baseUrl: string
  getToken: () => Promise<string | null>
  fetch?: typeof fetch
}

export class SyncApi {
  private readonly base: string
  private readonly getToken: () => Promise<string | null>
  private readonly fetchFn: typeof fetch

  constructor(opts: SyncApiOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.getToken = opts.getToken
    this.fetchFn = opts.fetch ?? ((...a) => globalThis.fetch(...a))
  }

  async push(docId: string, deviceId: string, update: Uint8Array): Promise<{ seq: number }> {
    return this.req('POST', '/sync/push', { docId, deviceId, update: bytesToBase64(update) })
  }

  async pull(docId: string, since: number, limit: number): Promise<PullResult> {
    const q = new URLSearchParams({ docId, since: String(since), limit: String(limit) })
    const r = await this.req<{
      updates: { seq: number; update: string }[]
      latestSeq: number
      snapshot?: { uptoSeq: number; data: string } | null
    }>('GET', `/sync/pull?${q}`)
    return {
      updates: r.updates.map((u) => ({ seq: u.seq, update: base64ToBytes(u.update) })),
      latestSeq: r.latestSeq,
      snapshot: r.snapshot ? { uptoSeq: r.snapshot.uptoSeq, data: base64ToBytes(r.snapshot.data) } : undefined,
    }
  }

  async compact(docId: string, uptoSeq: number, snapshot: Uint8Array): Promise<void> {
    await this.req('POST', '/sync/compact', { docId, uptoSeq, snapshot: bytesToBase64(snapshot) })
  }

  listDocs(): Promise<RemoteDocInfo[]> {
    return this.req('GET', '/sync/docs')
  }

  changes(since: number, signal: AbortSignal): Promise<{ cursor: number; docs: RemoteDocInfo[] }> {
    return this.req('GET', `/sync/changes?since=${since}`, undefined, signal)
  }

  async registerDevice(deviceId: string, name: string): Promise<void> {
    await this.req('POST', '/devices', { deviceId, name })
  }

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const token = await this.getToken()
    // No token: behave like a 401 without touching the network.
    if (!token) throw new SyncHttpError(401, 'unauthorized', 'not signed in')
    let res: Response
    try {
      res = await this.fetchFn(this.base + path, {
        method,
        signal,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (e) {
      throw new SyncHttpError(0, 'network', e instanceof Error ? e.message : 'network error')
    }
    if (!res.ok) {
      let code = 'error'
      let message = res.statusText || `HTTP ${res.status}`
      try {
        const j = (await res.json()) as { error?: string; message?: string }
        code = j.error ?? code
        message = j.message ?? message
      } catch { /* non-JSON error body */ }
      const ra = Number(res.headers?.get?.('Retry-After'))
      throw new SyncHttpError(res.status, code, message, Number.isFinite(ra) && ra > 0 ? ra : undefined)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
}
