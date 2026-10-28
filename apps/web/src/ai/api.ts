/**
 * REST and SSE client for the folio-server AI gateway (shapes in `./protocol.ts`).
 * Streams are POST requests answered with `text/event-stream`, so they go through `fetch`, not EventSource.
 */
import type { NotebookId } from '@folio/document'
import type { AuthService } from '../services/auth'
import { runtimeConfig } from '../services/runtime-config'
import type {
  ContinueReq,
  AiConfigRes, AiErrorCode, CreateThreadReq, Instructions, ResultsReq, StartTurnReq, StepEvent, StepReq, ThreadDetailRes,
  ThreadListRes, ThreadSummary, TurnInfo, UpdateThreadReq,
} from './protocol'

/** Why AI is unavailable right now, or null when it can be used. */
export function aiDisabledReason(auth: Pick<AuthService, 'signedIn' | 'online'>): string | null {
  if (!runtimeConfig.apiBase) return 'AI needs a folio server.'
  if (!auth.online.value) return 'AI needs an internet connection.'
  if (!auth.signedIn.value) return 'Create an account and sign in to use AI features.'
  return null
}

const ERROR_CODES: readonly AiErrorCode[] = [
  'ai_not_configured', 'credit_exhausted', 'not_turn_device', 'turn_not_awaiting', 'no_vision', 'upstream', 'bad_request', 'conflict',
]
const isErrorCode = (v: unknown): v is AiErrorCode => ERROR_CODES.includes(v as AiErrorCode)

const FRIENDLY: Record<AiErrorCode, string> = {
  ai_not_configured: 'AI is not configured on the server.',
  credit_exhausted: 'Your AI credit for today is used up. It resets at midnight UTC.',
  not_turn_device: 'This turn runs on another device.',
  turn_not_awaiting: 'This turn already moved on. Reload the thread.',
  no_vision: 'This preset cannot see images. Pick another preset or remove the images.',
  upstream: 'The AI provider had a problem. Try again in a moment.',
  bad_request: 'The server did not accept the request.',
  conflict: 'Another turn in this thread is still running.',
}

/** A user-facing message by error code first, then by HTTP status. */
export function friendlyError(code: AiErrorCode | null, status: number | null, fallback?: string): string {
  if (code) return FRIENDLY[code]
  if (status === 401) return 'Please sign in again.'
  if (status === 403) return 'You do not have access to this thread.'
  if (status === 404) return 'This thread no longer exists.'
  if (status === 429) return 'Too many requests. Wait a moment and try again.'
  if (status === 503) return FRIENDLY.ai_not_configured
  if (status !== null && status >= 500) return 'The folio server had a problem. Try again in a moment.'
  return fallback || (status ? `AI request failed (${status}).` : 'Could not reach the folio server.')
}

export class AiApiError extends Error {
  override name = 'AiApiError'
  constructor(readonly code: AiErrorCode | null, readonly status: number | null, message?: string) {
    super(friendlyError(code, status, message))
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export interface SseMessage { event: string; data: string }

/** Split a byte stream into server-sent events (`event:` and multi-line `data:` fields, `:` comments ignored). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let event = ''
  let data: string[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buf += decoder.decode(value, { stream: !done })
      let nl: number
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + (buf.startsWith('\r\n', nl) ? 2 : 1))
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n') }
          event = ''
          data = []
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') event = val
        else if (field === 'data') data.push(val)
      }
      if (done) break
    }
    if (data.length) yield { event: event || 'message', data: data.join('\n') }
  } finally {
    reader.releaseLock()
  }
}

const STEP_EVENT_TYPES: readonly StepEvent['type'][] = ['turn', 'text_delta', 'item', 'usage', 'step_end', 'thread', 'error']

/** Step events from an SSE body. Unknown or malformed events are skipped. */
export async function* readStepEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StepEvent> {
  for await (const m of readSse(body)) {
    let parsed: unknown
    try { parsed = JSON.parse(m.data) } catch { continue }
    if (typeof parsed !== 'object' || parsed === null) continue
    const type = (parsed as { type?: unknown }).type
    if (STEP_EVENT_TYPES.includes(type as StepEvent['type'])) yield parsed as StepEvent
  }
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export interface AiApiOptions {
  getToken: () => Promise<string | null>
  /** Read at call time: the runtime config can change during boot. */
  base?: () => string
  fetch?: typeof fetch
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export class AiApi {
  private readonly base: () => string
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: AiApiOptions) {
    this.base = opts.base ?? (() => runtimeConfig.apiBase)
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a))
  }

  private async send(method: Method, path: string, body?: BodyInit | object, signal?: AbortSignal, contentType = 'application/json'): Promise<Response> {
    const token = await this.opts.getToken()
    const headers: Record<string, string> = {}
    if (token) headers.authorization = `Bearer ${token}`
    let payload: BodyInit | undefined
    if (body instanceof Blob) {
      payload = body
      headers['content-type'] = contentType
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    let res: Response
    try {
      res = await this.fetchFn(`${this.base()}${path}`, { method, headers, body: payload, signal })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      throw new AiApiError(null, null)
    }
    if (!res.ok) {
      let code: AiErrorCode | null = null
      let message: string | undefined
      try {
        const j = (await res.json()) as { error?: unknown; code?: unknown; message?: unknown }
        const c = j.code ?? j.error
        if (isErrorCode(c)) code = c
        if (typeof j.message === 'string') message = j.message
      } catch { /* not JSON */ }
      throw new AiApiError(code, res.status, message)
    }
    return res
  }

  private async json<T>(method: Method, path: string, body?: object): Promise<T> {
    return (await (await this.send(method, path, body)).json()) as T
  }

  private async *stream(path: string, body: object, signal?: AbortSignal): AsyncGenerator<StepEvent> {
    const res = await this.send('POST', path, body, signal)
    if (!res.body) throw new AiApiError(null, res.status, 'The server sent an empty stream.')
    yield* readStepEvents(res.body)
  }

  config(): Promise<AiConfigRes> { return this.json('GET', '/ai/config') }

  threads(q: { notebookId: NotebookId | null; search?: string; settled?: boolean }): Promise<ThreadListRes> {
    const p = new URLSearchParams({ notebookId: q.notebookId ?? 'library' })
    if (q.settled !== undefined) p.set('settled', q.settled ? '1' : '0')
    if (q.search?.trim()) p.set('search', q.search.trim())
    return this.json('GET', `/ai/threads?${p}`)
  }
  createThread(req: CreateThreadReq): Promise<ThreadSummary> { return this.json('POST', '/ai/threads', req) }
  updateThread(id: string, req: UpdateThreadReq): Promise<ThreadSummary> { return this.json('PATCH', `/ai/threads/${enc(id)}`, req) }
  async deleteThread(id: string): Promise<void> { await this.send('DELETE', `/ai/threads/${enc(id)}`) }
  thread(id: string): Promise<ThreadDetailRes> { return this.json('GET', `/ai/threads/${enc(id)}`) }

  startTurn(threadId: string, req: StartTurnReq, signal?: AbortSignal): AsyncGenerator<StepEvent> {
    return this.stream(`/ai/threads/${enc(threadId)}/turns`, req, signal)
  }
  step(turnId: string, req: StepReq, signal?: AbortSignal): AsyncGenerator<StepEvent> {
    return this.stream(`/ai/turns/${enc(turnId)}/step`, req, signal)
  }
  continueTurn(turnId: string, req: ContinueReq, signal?: AbortSignal): AsyncGenerator<StepEvent> {
    return this.stream(`/ai/turns/${enc(turnId)}/continue`, req, signal)
  }
  async postResults(turnId: string, req: ResultsReq): Promise<void> { await this.send('POST', `/ai/turns/${enc(turnId)}/results`, req) }
  cancel(turnId: string): Promise<TurnInfo> { return this.json('POST', `/ai/turns/${enc(turnId)}/cancel`) }
  revert(turnId: string): Promise<ThreadDetailRes> { return this.json('POST', `/ai/turns/${enc(turnId)}/revert`) }

  instructions(notebookId: NotebookId | null): Promise<Instructions> {
    return this.json('GET', `/ai/instructions${notebookId ? `?notebookId=${enc(notebookId)}` : ''}`)
  }
  saveInstructions(i: Instructions): Promise<Instructions> { return this.json('PUT', '/ai/instructions', i) }

  /** Upload image bytes under a known asset id (the same id the local asset store uses). */
  async uploadAsset(id: string, blob: Blob): Promise<void> {
    await this.send('POST', `/assets?id=${enc(id)}`, blob, undefined, blob.type || 'application/octet-stream')
  }
}

const enc = encodeURIComponent

/** The parts of AiApi the turn driver uses (tests pass a fake). */
export type TurnApi = Pick<AiApi, 'startTurn' | 'step' | 'continueTurn' | 'postResults' | 'cancel' | 'revert' | 'thread' | 'createThread'>
