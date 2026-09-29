import { describe, expect, it } from 'vitest'
import { NotebookDocument, createPage } from '../src'
import { snapshotState, stroke, text } from './helpers'

function pair() {
  const a = NotebookDocument.create({ title: 'N' }, { peerId: 1 })
  const b = NotebookDocument.fromSnapshot(a.exportSnapshot(), { peerId: 2 })
  return { a, b, P: a.pages()[0].id }
}
function exchange(a: NotebookDocument, b: NotebookDocument) {
  const ua = a.exportUpdates(b.version())
  const ub = b.exportUpdates(a.version())
  b.importUpdates(ua)
  a.importUpdates(ub)
}

describe('CRDT convergence', () => {
  it('concurrent strokes, page adds, moves, delete vs update', () => {
    const { a, b, P } = pair()
    const shared = text('shared', 0, 0)
    const victim = stroke()
    a.apply([{ type: 'addObjects', pageId: P, objects: [shared, victim] }])
    exchange(a, b)
    expect(b.objects(P)).toHaveLength(2)

    // offline concurrent edits
    const sa = stroke(1, 1), sb = stroke(2, 2)
    a.apply([{ type: 'addObjects', pageId: P, objects: [sa] }])
    b.apply([{ type: 'addObjects', pageId: P, objects: [sb] }])
    a.apply([{ type: 'updateObjects', pageId: P, patches: [{ id: shared.id, patch: { transform: { x: 10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } } }] }])
    b.apply([{ type: 'updateObjects', pageId: P, patches: [{ id: shared.id, patch: { transform: { x: 0, y: 99, rotation: 0, scaleX: 1, scaleY: 1 }, color: '#f00' } }] }])
    a.apply([{ type: 'deleteObjects', pageId: P, ids: [victim.id] }])
    b.apply([{ type: 'updateObjects', pageId: P, patches: [{ id: victim.id, patch: { z: 500 } }] }])
    const pa = createPage({ order: 2, now: 1 }), pb = createPage({ order: 3, now: 2 })
    a.apply([{ type: 'addPage', page: pa }])
    b.apply([{ type: 'addPage', page: pb }, { type: 'addObjects', pageId: pb.id, objects: [stroke()] }])
    a.apply([{ type: 'updateMeta', patch: { title: 'A title' } }])

    exchange(a, b)
    expect(snapshotState(a)).toEqual(snapshotState(b))
    expect(a.pages()).toHaveLength(3)
    expect(a.objects(P).map((o) => o.id)).toContain(sa.id)
    expect(a.objects(P).map((o) => o.id)).toContain(sb.id)
    expect(a.object(P, victim.id)).toBeUndefined() // delete wins
    // different fields of the same object merge
    expect((a.object(P, shared.id) as { color: string }).color).toBe('#f00')
    expect(a.meta().title).toBe('A title')
    // and both match a fresh load
    expect(snapshotState(NotebookDocument.fromSnapshot(a.exportSnapshot()))).toEqual(snapshotState(a))
  })

  it('remote import emits a remote event with affected ids and keeps cache consistent', () => {
    const { a, b, P } = pair()
    const evs: any[] = []
    b.subscribe((e) => evs.push(e))
    const s = stroke()
    a.apply([{ type: 'addObjects', pageId: P, objects: [s] }])
    const before = b.objects(P)
    b.importUpdates(a.exportUpdates(b.version()))
    expect(evs).toHaveLength(1)
    expect(evs[0].origin).toBe('remote')
    expect([...evs[0].objectIds]).toEqual([s.id])
    expect(b.objects(P)).not.toBe(before)
    expect(b.objects(P).map((o) => o.id)).toEqual([s.id])
    // re-importing the same data is a no-op (no event)
    b.importUpdates(a.exportUpdates())
    expect(evs).toHaveLength(1)
    // local edit after remote import still works and syncs back
    b.apply([{ type: 'deleteObjects', pageId: P, ids: [s.id] }])
    a.importUpdates(b.exportUpdates(a.version()))
    expect(a.objects(P)).toHaveLength(0)
  })

  it('exportUpdates(since) only carries the delta', () => {
    const { a, b, P } = pair()
    for (let i = 0; i < 50; i++) a.apply([{ type: 'addObjects', pageId: P, objects: [stroke(i, i, 20)] }])
    b.importUpdates(a.exportUpdates())
    const v = a.version()
    const s = stroke()
    a.apply([{ type: 'addObjects', pageId: P, objects: [s] }])
    const delta = a.exportUpdates(v)
    expect(delta.length).toBeLessThan(a.exportUpdates().length / 5)
    b.importUpdates(delta)
    expect(snapshotState(a)).toEqual(snapshotState(b))
  })

  it('snapshot round-trip preserves everything', () => {
    const { a, P } = pair()
    a.apply([{ type: 'addObjects', pageId: P, objects: [stroke(), text('x', 1, 2)] }])
    const c = NotebookDocument.fromSnapshot(a.exportSnapshot())
    expect(snapshotState(c)).toEqual(snapshotState(a))
    expect(c.id).toBe(a.id)
  })

  it('empty(id) can receive a full history', () => {
    const { a, P } = pair()
    a.apply([{ type: 'addObjects', pageId: P, objects: [stroke()] }])
    const e = NotebookDocument.empty(a.id)
    expect(e.pages()).toEqual([])
    e.importUpdates(a.exportUpdates())
    expect(snapshotState(e)).toEqual(snapshotState(a))
  })
})
