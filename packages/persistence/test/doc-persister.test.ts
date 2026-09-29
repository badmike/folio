import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeOrigin, Operation } from '@folio/document'
import { DocPersister, type DocFactory, type PersistableDoc } from '../src/doc-persister'
import { createMemoryState, MemoryStorage } from '../src/memory-storage'
import { createDiagnostics } from '../src/diagnostics'

/** Fake doc: state is the list of applied op titles; snapshot = JSON of that list. */
class FakeDoc implements PersistableDoc {
  titles: string[] = []
  origins: (string | undefined)[] = []
  listeners = new Set<(e: { origin: ChangeOrigin }) => void>()
  constructor(init: string[] = []) { this.titles = init }
  apply(ops: Operation[], origin?: 'local' | 'journal') {
    // validate first so a failing batch is atomic
    for (const o of ops) if ((o as any).patch?.title === 'BAD') throw new Error('bad op')
    for (const o of ops) this.titles.push((o as any).patch.title)
    this.origins.push(origin)
  }
  exportSnapshot() { return new TextEncoder().encode(JSON.stringify(this.titles)) }
  subscribe(cb: (e: { origin: ChangeOrigin }) => void) { this.listeners.add(cb); return () => this.listeners.delete(cb) }
  emit(origin: ChangeOrigin) { this.listeners.forEach((l) => l({ origin })) }
}
const factory: DocFactory<FakeDoc> = {
  fromSnapshot: (b) => new FakeDoc(JSON.parse(new TextDecoder().decode(b))),
  empty: () => new FakeDoc(),
}
const op = (t: string): Operation => ({ type: 'updateMeta', patch: { title: t } as never })

describe('DocPersister', () => {
  let state: ReturnType<typeof createMemoryState>
  let storage: MemoryStorage
  beforeEach(() => { state = createMemoryState(); storage = new MemoryStorage(state); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const make = (o = {}) => new DocPersister<FakeDoc>(storage, { listenToPageEvents: false, ...o })

  it('recovers: replays journal ops with origin "journal" after a crash', async () => {
    const p1 = make()
    const d1 = await p1.load('nb', factory)
    for (const t of ['a', 'b', 'c']) { d1.apply([op(t)]); await p1.record([op(t)]) }
    // crash: no flush, no snapshot. New session over the same storage:
    const p2 = make()
    const d2 = await p2.load('nb', factory)
    expect(d2.titles).toEqual(['a', 'b', 'c'])
    expect(new Set(d2.origins)).toEqual(new Set(['journal']))
  })

  it('debounced idle snapshot compacts the journal', async () => {
    const p = make({ idleMs: 5000 })
    const d = await p.load('nb', factory)
    d.apply([op('a')]); await p.record([op('a')])
    expect((await storage.loadDoc('nb')).pendingOps).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect((await storage.loadDoc('nb')).snapshot).toBeNull()
    await vi.advanceTimersByTimeAsync(2)
    const s = await storage.loadDoc('nb')
    expect(s.snapshot).not.toBeNull()
    expect(s.pendingOps).toEqual([])
    const d2 = await make().load('nb', factory)
    expect(d2.titles).toEqual(['a'])
  })

  it('snapshots after N recorded batches without waiting for idle', async () => {
    const p = make({ snapshotEveryOps: 3, idleMs: 60_000 })
    const d = await p.load('nb', factory)
    for (const t of ['a', 'b', 'c']) { d.apply([op(t)]); void p.record([op(t)]) }
    await p.flush()
    const s = await storage.loadDoc('nb')
    expect(s.pendingOps).toEqual([])
    expect(s.snapshotSeq).toBe(3)
  })

  it('flush() persists immediately; ops recorded after a snapshot stay in the journal', async () => {
    const p = make()
    const d = await p.load('nb', factory)
    d.apply([op('a')]); await p.record([op('a')])
    await p.flush()
    d.apply([op('b')]); await p.record([op('b')])
    const s = await storage.loadDoc('nb')
    expect(s.pendingOps).toHaveLength(1)
    const d2 = await make().load('nb', factory)
    expect(d2.titles).toEqual(['a', 'b'])
  })

  it('keeps journal order for unawaited record() calls', async () => {
    const p = make()
    const d = await p.load('nb', factory)
    const ts = ['1', '2', '3', '4', '5', '6']
    ts.forEach((t) => { d.apply([op(t)]); void p.record([op(t)]) })
    await p.flush()
    await p.dispose()
    const d2 = await make().load('nb', factory)
    expect(d2.titles).toEqual(ts)
  })

  it('remote changes mark dirty and snapshot soon', async () => {
    const p = make({ remoteDelayMs: 1000 })
    const d = await p.load('nb', factory)
    d.titles.push('remote-op')
    d.emit('remote')
    await vi.advanceTimersByTimeAsync(1001)
    expect((await storage.loadDoc('nb')).snapshot).not.toBeNull()
    // non-remote origins alone do not trigger writes
    const before = (await storage.loadDoc('nb')).snapshotSeq
    d.emit('local'); d.emit('load'); d.emit('journal')
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await storage.loadDoc('nb')).snapshotSeq).toBe(before)
  })

  it('a failing op does not block the others (and is quarantined, not lost)', async () => {
    await storage.appendOps('nb', [op('a')])
    await storage.appendOps('nb', [op('x'), op('BAD'), op('y')])
    await storage.appendOps('nb', [op('z')])
    const errors: unknown[] = []
    const p = make({ onError: (e: unknown) => errors.push(e) })
    const d = await p.load('nb', factory)
    expect(d.titles).toEqual(['a', 'x', 'y', 'z'])
    expect(errors.length).toBeGreaterThan(0)
    await p.flush()
    expect((await storage.loadDoc('nb')).pendingOps).toEqual([])
    const q = await storage.getSetting<{ op: any }[]>('quarantine:nb')
    expect(q).toHaveLength(1)
    expect(q![0].op.patch.title).toBe('BAD')
  })

  it('reports storage errors via onError and keeps working', async () => {
    const errs: { phase: string }[] = []
    const diag = createDiagnostics()
    const p = make({ onError: (e: unknown, i: { phase: string }) => { errs.push(i); diag.log(i.phase, e) } })
    const d = await p.load('nb', factory)
    const orig = storage.appendOps.bind(storage)
    let fail = true
    storage.appendOps = async (...a) => { if (fail) { fail = false; throw new Error('disk full') } return orig(...a) }
    d.apply([op('a')]); expect(await p.record([op('a')])).toBeNull()
    d.apply([op('b')]); expect(await p.record([op('b')])).toBeGreaterThan(0)
    expect(errs.map((e) => e.phase)).toEqual(['append'])
    await p.flush() // snapshot covers 'a' even though its journal write failed
    const d2 = await make().load('nb', factory)
    expect(d2.titles).toEqual(['a', 'b'])
    expect(JSON.parse(diag.exportJson()).entries[0].message).toContain('disk full')
  })

  it('dispose flushes and detaches', async () => {
    const p = make()
    const d = await p.load('nb', factory)
    d.apply([op('a')]); void p.record([op('a')])
    await p.dispose()
    expect((await storage.loadDoc('nb')).pendingOps).toEqual([])
    expect(d.listeners.size).toBe(0)
  })
})
