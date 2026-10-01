import type { Storage, SyncState } from '@folio/persistence'
import type { DocHandle } from '../src'
import { base64ToBytes, bytesToBase64 } from '../src'

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
const dec = <T>(b: Uint8Array): T => JSON.parse(new TextDecoder().decode(b)) as T

interface Op { peer: string; n: number; text: string }

/** Fake CRDT: grow-only set of ops; version = highest counter per peer. */
export class FakeDoc implements DocHandle {
  ops = new Map<string, Op>()
  private counter = 0
  constructor(public peer: string) {}
  edit(text: string): void {
    const op = { peer: this.peer, n: ++this.counter, text }
    this.ops.set(`${op.peer}:${op.n}`, op)
  }
  texts(): string[] { return [...this.ops.values()].map((o) => o.text).sort() }
  version(): Uint8Array {
    const v: Record<string, number> = {}
    for (const o of this.ops.values()) v[o.peer] = Math.max(v[o.peer] ?? 0, o.n)
    return enc(Object.fromEntries(Object.entries(v).sort()))
  }
  exportUpdates(since?: Uint8Array): Uint8Array {
    const s = since ? dec<Record<string, number>>(since) : {}
    return enc([...this.ops.values()].filter((o) => o.n > (s[o.peer] ?? 0)))
  }
  importUpdates(bytes: Uint8Array): void {
    for (const o of dec<Op[]>(bytes)) this.ops.set(`${o.peer}:${o.n}`, o)
  }
  exportSnapshot(): Uint8Array { return this.exportUpdates() }
}

export class FakeStorage {
  states = new Map<string, SyncState>()
  settings = new Map<string, unknown>()
  ids: string[] = []
  async getSyncState(id: string) { return this.states.get(id) ?? null }
  async setSyncState(s: SyncState) { this.states.set(s.docId, s) }
  async listDocIds() { return [...this.ids] }
  async getSetting(k: string) { return this.settings.get(k) }
  async setSetting(k: string, v: unknown) { this.settings.set(k, v) }
  asStorage(): Storage { return this as unknown as Storage }
}

export class FakeServer {
  docs = new Map<string, { updates: { seq: number; update: string }[]; latest: number; snapshot?: { uptoSeq: number; data: string } }>()
  private changesCursor = 0
  private changed = new Map<string, number>()
  private changeListeners = new Set<() => void>()
  token = 'tok'
  down = false
  pushes = 0 // pushes of non-workspace docs
  hook: ((path: string) => Promise<void>) | null = null
  pulls = 0
  status: number | null = null // force an HTTP status

  private doc(id: string) {
    let d = this.docs.get(id)
    if (!d) this.docs.set(id, (d = { updates: [], latest: 0 }))
    return d
  }

  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError('network down')
    const url = new URL(String(input))
    await this.hook?.(url.pathname)
    const auth = (init?.headers as Record<string, string>)?.Authorization
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (this.status) return json(this.status, { error: 'forced', message: 'forced' })
    if (auth !== `Bearer ${this.token}`) return json(401, { error: 'unauthorized', message: 'bad token' })
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname === '/sync/push') {
      if (body.docId !== 'workspace') this.pushes++
      const d = this.doc(body.docId)
      d.latest++
      d.updates.push({ seq: d.latest, update: body.update })
      this.changed.set(body.docId, ++this.changesCursor)
      for (const notify of [...this.changeListeners]) notify()
      return json(200, { seq: d.latest })
    }
    if (url.pathname === '/sync/pull') {
      if (url.searchParams.get('docId') !== 'workspace') this.pulls++
      const d = this.doc(url.searchParams.get('docId')!)
      const since = Number(url.searchParams.get('since'))
      const limit = Number(url.searchParams.get('limit'))
      const from = Math.max(since, d.snapshot && since < d.snapshot.uptoSeq ? d.snapshot.uptoSeq : since)
      const updates = d.updates.filter((u) => u.seq > from).slice(0, limit)
      return json(200, { updates, latestSeq: d.latest, snapshot: d.snapshot && since < d.snapshot.uptoSeq ? d.snapshot : undefined })
    }
    if (url.pathname === '/sync/compact') {
      const d = this.doc(body.docId)
      d.snapshot = { uptoSeq: body.uptoSeq, data: body.snapshot }
      d.updates = d.updates.filter((u) => u.seq > body.uptoSeq)
      return json(200, {})
    }
    if (url.pathname === '/sync/changes') {
      const since = Number(url.searchParams.get('since'))
      return new Promise<Response>((resolve, reject) => {
        const cleanup = () => { this.changeListeners.delete(notify); init?.signal?.removeEventListener('abort', abort) }
        const abort = () => { cleanup(); reject(new DOMException('aborted', 'AbortError')) }
        const notify = () => {
          const docs = [...this.changed].filter(([, revision]) => revision > since)
            .map(([docId]) => ({ docId, latestSeq: this.docs.get(docId)!.latest, updatedAt: 0 }))
          if (!docs.length) return
          cleanup()
          resolve(json(200, { cursor: this.changesCursor, docs }))
        }
        this.changeListeners.add(notify)
        init?.signal?.addEventListener('abort', abort, { once: true })
        if (init?.signal?.aborted) abort()
        else notify()
      })
    }
    if (url.pathname === '/sync/docs') {
      return json(200, [...this.docs].map(([docId, d]) => ({ docId, latestSeq: d.latest, updatedAt: 0 })))
    }
    return json(404, { error: 'not_found', message: url.pathname })
  }
}

export { bytesToBase64, base64ToBytes }
