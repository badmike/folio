import { describe, expect, it, vi } from 'vitest'
import { SyncApi, SyncEngine, base64ToBytes, bytesToBase64 } from '../src'
import { FakeDoc, FakeServer, FakeStorage } from './fakes'

function device(server: FakeServer, name: string, extra: { threshold?: number; limit?: number; token?: () => Promise<string | null> } = {}) {
  const storage = new FakeStorage()
  const docs = new Map<string, FakeDoc>()
  const remote: string[] = []
  const api = new SyncApi({ baseUrl: 'http://x/', getToken: extra.token ?? (async () => server.token), fetch: server.fetch })
  const engine = new SyncEngine({
    api, storage: storage.asStorage(), deviceId: name,
    openDoc: async (id) => { if (!docs.has(id)) docs.set(id, new FakeDoc(name)); return docs.get(id)! },
    onRemoteDoc: (id) => remote.push(id),
    compactThreshold: extra.threshold, pullLimit: extra.limit,
  })
  const doc = (id = 'nb1') => { if (!docs.has(id)) { docs.set(id, new FakeDoc(name)); storage.ids.push(id) } return docs.get(id)! }
  return { storage, docs, remote, engine, doc }
}

describe('base64', () => {
  it('round-trips large arrays', () => {
    const b = Uint8Array.from({ length: 1_000_000 }, (_, i) => i % 251)
    const back = base64ToBytes(bytesToBase64(b))
    // compare directly: a deep equal over a million elements can take seconds on a slow runner
    expect(back.length).toBe(b.length)
    expect(back.every((v, i) => v === b[i])).toBe(true)
  })
})

describe('SyncEngine', () => {
  it('streams ongoing edits to a second device without waiting for writing to stop', async () => {
    vi.useFakeTimers()
    const s = new FakeServer()
    const a = device(s, 'A'), b = device(s, 'B')
    try {
      a.engine.start(); b.engine.start()
      await vi.advanceTimersByTimeAsync(10)
      for (let i = 0; i < 8; i++) {
        a.doc().edit(`stroke${i}`)
        a.engine.notifyLocalChange('nb1')
        await vi.advanceTimersByTimeAsync(50)
      }
      expect(s.pushes).toBeGreaterThanOrEqual(2)
      expect(b.doc().texts().length).toBeGreaterThanOrEqual(6)
      await vi.advanceTimersByTimeAsync(150)
      expect(b.doc().texts()).toEqual(a.doc().texts())
    } finally {
      a.engine.stop(); b.engine.stop()
      vi.useRealTimers()
    }
  })

  it('recovers changes made while the realtime feed was disconnected', async () => {
    vi.useFakeTimers()
    const s = new FakeServer()
    const a = device(s, 'A'), b = device(s, 'B')
    try {
      s.status = 503
      b.engine.start()
      await vi.advanceTimersByTimeAsync(10)
      s.status = null
      a.doc().edit('offline-feed')
      await a.engine.syncDoc('nb1')
      await vi.advanceTimersByTimeAsync(2500)
      expect(b.doc().texts()).toEqual(['offline-feed'])
    } finally {
      b.engine.stop()
      vi.useRealTimers()
    }
  })

  it('converges two devices after offline edits', async () => {
    const s = new FakeServer()
    const a = device(s, 'A'), b = device(s, 'B')
    a.doc().edit('a1'); a.doc().edit('a2')
    b.doc().edit('b1')
    await a.engine.syncDoc('nb1')
    await b.engine.syncDoc('nb1')
    await a.engine.syncDoc('nb1')
    expect(a.doc().texts()).toEqual(['a1', 'a2', 'b1'])
    expect(b.doc().texts()).toEqual(['a1', 'a2', 'b1'])
  })

  it('pulls before pushing and avoids re-pushing unchanged docs', async () => {
    const s = new FakeServer()
    const a = device(s, 'A'), b = device(s, 'B')
    a.doc().edit('a1')
    await a.engine.syncDoc('nb1')
    expect(s.pushes).toBe(1)
    await a.engine.syncDoc('nb1')
    expect(s.pushes).toBe(1)
    // B pulls A's data; having no local edits it must not echo it back.
    await b.engine.syncAll() // nb1 is remote-only for B
    expect(b.doc().texts()).toEqual(['a1'])
    expect(s.pushes).toBe(1)
    expect(b.storage.states.get('nb1')!.pulledSeq).toBe(1)
  })

  it.each(['pull', 'persist'] as const)('pushes a local stroke written during a remote %s', async (during) => {
    const s = new FakeServer()
    const a = device(s, 'A'), b = device(s, 'B')
    a.doc().edit('first')
    await a.engine.syncDoc('nb1')
    await b.engine.syncDoc('nb1')
    b.doc().edit('remote')
    await b.engine.syncDoc('nb1')

    let written = false
    const write = () => {
      if (written) return
      written = true
      a.doc().edit('while-pulling')
      a.engine.notifyLocalChange('nb1')
    }
    if (during === 'pull') s.hook = async (path) => { if (path === '/sync/pull') write() }
    else {
      const persist = a.storage.setSyncState.bind(a.storage)
      vi.spyOn(a.storage, 'setSyncState').mockImplementation(async (state) => { write(); await persist(state) })
    }
    await a.engine.syncDoc('nb1')
    s.hook = null
    await b.engine.syncDoc('nb1')
    expect(b.doc().texts()).toEqual(['first', 'remote', 'while-pulling'])
  })

  it('leaves pulledSeq when others pushed concurrently', async () => {
    const s = new FakeServer()
    const a = device(s, 'A'), b = device(s, 'B')
    a.doc().edit('a1'); await a.engine.syncDoc('nb1')
    b.doc().edit('b1')
    // A pushes between B's pull and push.
    let injected = false
    s.hook = async (path) => {
      if (path === '/sync/push' && !injected) { injected = true; a.doc().edit('a2'); await a.engine.syncDoc('nb1') }
    }
    await b.engine.syncDoc('nb1')
    // pulledSeq must NOT have skipped A's concurrent update
    expect(b.storage.states.get('nb1')!.pulledSeq).toBeLessThan(s.docs.get('nb1')!.latest)
    s.hook = null
    await b.engine.syncDoc('nb1')
    expect(b.doc().texts()).toEqual(['a1', 'a2', 'b1'])
  })

  it('offline leaves state intact, retries later', async () => {
    const s = new FakeServer()
    const a = device(s, 'A')
    a.doc().edit('a1')
    s.down = true
    await expect(a.engine.syncDoc('nb1')).rejects.toThrow()
    expect(a.engine.getStatus().state).toBe('offline')
    expect(a.storage.states.get('nb1')).toBeUndefined()
    s.down = false
    await a.engine.syncDoc('nb1')
    expect(a.engine.getStatus().state).toBe('idle')
    expect(s.pushes).toBe(1)
    expect(a.storage.states.get('nb1')!.pushedVersion).not.toBeNull()
  })

  it('401 -> signed-out without hitting the network when no token', async () => {
    const s = new FakeServer()
    let token: string | null = null
    const a = device(s, 'A', { token: async () => token })
    a.doc().edit('a1')
    await expect(a.engine.syncAll()).rejects.toThrow()
    expect(a.engine.getStatus().state).toBe('signed-out')
    expect(s.pushes + s.pulls).toBe(0)
    token = 'wrong'
    await expect(a.engine.syncAll()).rejects.toThrow()
    expect(a.engine.getStatus().state).toBe('signed-out')
    token = 'tok'
    await a.engine.syncAll()
    expect(a.engine.getStatus().state).toBe('idle')
    expect(s.pushes).toBe(1)
  })

  it('compacts and bootstraps a new device from snapshot + updates', async () => {
    const s = new FakeServer()
    const a = device(s, 'A', { threshold: 5 })
    for (let i = 0; i < 8; i++) { a.doc().edit('e' + i); await a.engine.syncDoc('nb1') }
    expect(s.docs.get('nb1')!.snapshot).toBeDefined()
    a.doc().edit('late'); await a.engine.syncDoc('nb1')
    const b = device(s, 'B')
    await b.engine.syncAll()
    expect(b.doc('nb1').texts()).toEqual([...a.doc().texts()])
    expect(b.doc('nb1').texts()).toContain('late')
  })

  it('discovers remote docs and calls onRemoteDoc', async () => {
    const s = new FakeServer()
    const a = device(s, 'A'), b = device(s, 'B')
    a.doc('nbX').edit('x')
    await a.engine.syncAll()
    await b.engine.syncAll()
    expect(b.remote).toEqual(['nbX'])
    expect(b.docs.get('nbX')!.texts()).toEqual(['x'])
    expect(s.pushes).toBe(1) // B did not echo
  })

  it('pages pulls', async () => {
    const s = new FakeServer()
    const a = device(s, 'A')
    for (let i = 0; i < 7; i++) { a.doc().edit('e' + i); await a.engine.syncDoc('nb1') }
    const b = device(s, 'B', { limit: 3 })
    s.pulls = 0
    await b.engine.syncAll()
    expect(b.doc().texts()).toHaveLength(7)
    expect(s.pulls).toBe(3) // 3 + 3 + 1
    expect(b.storage.states.get('nb1')!.pulledSeq).toBe(7)
  })

  it('status reports pending and notifies subscribers; debounced local change syncs', async () => {
    vi.useFakeTimers()
    try {
      const s = new FakeServer()
      const a = device(s, 'A')
      const seen: string[] = []
      a.engine.subscribe((st) => seen.push(`${st.state}:${st.pending}`))
      a.engine.start()
      await vi.advanceTimersByTimeAsync(10)
      a.doc().edit('a1')
      a.engine.notifyLocalChange('nb1')
      expect(a.engine.getStatus().pending).toBe(1)
      await vi.advanceTimersByTimeAsync(1600)
      expect(s.pushes).toBe(1)
      expect(a.engine.getStatus()).toMatchObject({ state: 'idle', pending: 0 })
      expect(seen).toContain('syncing:1')
      a.engine.stop()
    } finally { vi.useRealTimers() }
  })

  it('backs off after errors', async () => {
    vi.useFakeTimers()
    try {
      const s = new FakeServer()
      const a = device(s, 'A')
      s.down = true
      a.engine.start()
      await vi.advanceTimersByTimeAsync(10)
      expect(a.engine.getStatus().state).toBe('offline')
      s.down = false
      await vi.advanceTimersByTimeAsync(5000) // > base backoff (2 s max), well under interval
      expect(a.engine.getStatus().state).toBe('idle')
      a.engine.stop()
    } finally { vi.useRealTimers() }
  })
  it('makes imported state durable before advancing pulledSeq', async () => {
    const s = new FakeServer()
    const a = device(s, 'A')
    a.doc().edit('a1'); await a.engine.syncDoc('nb1')

    const storage = new FakeStorage()
    const docs = new Map<string, FakeDoc>()
    const order: string[] = []
    const origSet = storage.setSyncState.bind(storage)
    storage.setSyncState = async (st) => { order.push(`state:${st.pulledSeq}`); await origSet(st) }
    const api = new SyncApi({ baseUrl: 'http://x/', getToken: async () => s.token, fetch: s.fetch })
    const engine = new SyncEngine({
      api, storage: storage.asStorage(), deviceId: 'B',
      openDoc: async (id) => { if (!docs.has(id)) docs.set(id, new FakeDoc('B')); return docs.get(id)! },
      beforeCommitPulled: async (id) => { order.push(`durable:${docs.get(id)!.texts().join(',')}`) },
    })
    storage.ids.push('nb1')
    await engine.syncDoc('nb1')
    expect(order.indexOf('durable:a1')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('durable:a1')).toBeLessThan(order.indexOf('state:1'))
  })

  it('does not advance pulledSeq when the durability hook fails', async () => {
    const s = new FakeServer()
    const a = device(s, 'A')
    a.doc().edit('a1'); await a.engine.syncDoc('nb1')

    const storage = new FakeStorage()
    const docs = new Map<string, FakeDoc>()
    const api = new SyncApi({ baseUrl: 'http://x/', getToken: async () => s.token, fetch: s.fetch })
    const engine = new SyncEngine({
      api, storage: storage.asStorage(), deviceId: 'B',
      openDoc: async (id) => { if (!docs.has(id)) docs.set(id, new FakeDoc('B')); return docs.get(id)! },
      beforeCommitPulled: async () => { throw new Error('disk full') },
    })
    storage.ids.push('nb1')
    await expect(engine.syncDoc('nb1')).rejects.toThrow('disk full')
    expect(storage.states.get('nb1')).toBeUndefined()
  })
})
