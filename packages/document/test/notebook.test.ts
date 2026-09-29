import { describe, expect, it } from 'vitest'
import { NotebookDocument, createPage, type DocChangeEvent, type Operation } from '../src'
import { arrow, shape, snapshotState, stroke, text, textRec } from './helpers'

const newDoc = (peer?: number) => NotebookDocument.create({ title: 'T', tags: ['a'] }, { peerId: peer, now: 1000 })
const pid = (d: NotebookDocument) => d.pages()[0].id

describe('basics', () => {
  it('creates a notebook with a first infinite page', () => {
    const d = newDoc(1)
    expect(d.meta().title).toBe('T')
    expect(d.pages()).toHaveLength(1)
    expect(d.pages()[0].kind).toBe('infinite')
    expect(d.id).toBe(d.meta().id)
  })

  it('emits change events with origin, pageIds and objectIds', () => {
    const d = newDoc(1)
    const evs: DocChangeEvent[] = []
    d.subscribe((e) => evs.push(e))
    const s = stroke()
    d.apply([{ type: 'addObjects', pageId: pid(d), objects: [s] }], 'journal')
    expect(evs).toHaveLength(1)
    expect(evs[0].origin).toBe('journal')
    expect([...evs[0].pageIds]).toEqual([pid(d)])
    expect([...evs[0].objectIds!]).toEqual([s.id])
    d.apply([{ type: 'updateMeta', patch: { title: 'X' } }])
    expect(evs[1].metaChanged).toBe(true)
  })

  it('sorts objects by z and keeps cached array stable between changes', () => {
    const d = newDoc(1)
    const a = stroke(0, 0, 3, { z: 5 }), b = stroke(0, 0, 3, { z: 2 })
    d.apply([{ type: 'addObjects', pageId: pid(d), objects: [a, b] }])
    expect(d.objects(pid(d)).map((o) => o.id)).toEqual([b.id, a.id])
    const first = d.objects(pid(d))
    expect(d.objects(pid(d))).toBe(first)
    d.apply([{ type: 'updateObjects', pageId: pid(d), patches: [{ id: b.id, patch: { z: 9 } }] }])
    expect(d.objects(pid(d)).map((o) => o.id)).toEqual([a.id, b.id])
    expect(first.map((o) => o.id)).toEqual([b.id, a.id]) // old array untouched
  })

  it('does not alias caller-provided objects', () => {
    const d = newDoc(1)
    const s = stroke()
    d.apply([{ type: 'addObjects', pageId: pid(d), objects: [s] }])
    s.style.color = 'red'
    expect((d.object(pid(d), s.id) as typeof s).style.color).toBe('#1e1e1e')
  })

  it('$unset removes fields, ink points are immutable', () => {
    const d = newDoc(1)
    const s = stroke(0, 0, 4, { supersededBy: 'x', groupId: 'g' })
    const P = pid(d)
    d.apply([{ type: 'addObjects', pageId: P, objects: [s] }])
    d.apply([{ type: 'updateObjects', pageId: P, patches: [{ id: s.id, patch: { $unset: ['supersededBy'], z: 42 } }] }])
    const o = d.object(P, s.id)!
    expect('supersededBy' in o).toBe(false)
    expect(o.groupId).toBe('g')
    expect(o.z).toBe(42)
    d.apply([{ type: 'updateObjects', pageId: P, patches: [{ id: s.id, patch: { points: [1, 2, 3, 4, 5, 6] } as never }] }])
    expect((d.object(P, s.id) as typeof s).points).toEqual(s.points)
    // survives snapshot
    const d2 = NotebookDocument.fromSnapshot(d.exportSnapshot())
    expect('supersededBy' in d2.object(P, s.id)!).toBe(false)
  })
})

describe('inverse', () => {
  const setup = () => {
    const d = newDoc(1)
    const P = pid(d)
    const s1 = stroke(), s2 = stroke(50, 50), t = text('hello', 10, 10), sh = shape(0, 0)
    const p2 = createPage({ kind: 'fixed', format: 'A4', order: 2, now: 5 })
    d.apply([
      { type: 'addObjects', pageId: P, objects: [s1, s2, t, sh] },
      { type: 'addPage', page: p2 },
      { type: 'addObjects', pageId: p2.id, objects: [stroke(1, 1)] },
      { type: 'setRecognitions', pageId: P, recognitions: [textRec('hi', 0, 0, 10, 10, [s1.id])] },
    ])
    return { d, P, s1, s2, t, sh, p2 }
  }

  const roundTrip = (d: NotebookDocument, ops: Operation[], expectChange = true) => {
    const before = snapshotState(d)
    const inv = d.inverse(ops)
    d.apply(ops)
    if (expectChange) expect(snapshotState(d)).not.toEqual(before)
    d.apply(inv)
    expect(snapshotState(d)).toEqual(before)
    // and the CRDT agrees with the cache
    const reloaded = NotebookDocument.fromSnapshot(d.exportSnapshot())
    expect(snapshotState(reloaded)).toEqual(before)
  }

  it('addObjects / deleteObjects', () => {
    const { d, P, s1, t } = setup()
    roundTrip(d, [{ type: 'addObjects', pageId: P, objects: [stroke(9, 9)] }])
    roundTrip(d, [{ type: 'deleteObjects', pageId: P, ids: [s1.id, t.id, 'missing'] }])
  })

  it('addObjects replacing an existing id', () => {
    const { d, P, t } = setup()
    roundTrip(d, [{ type: 'addObjects', pageId: P, objects: [{ ...t, text: 'replaced', fontSize: 40 }] }])
  })

  it('updateObjects incl. absent fields ($unset on undo)', () => {
    const { d, P, s1, t, sh } = setup()
    roundTrip(d, [{
      type: 'updateObjects', pageId: P, patches: [
        { id: s1.id, patch: { supersededBy: 'abc', transform: { x: 5, y: 5, rotation: 1, scaleX: 2, scaleY: 2 } } },
        { id: t.id, patch: { text: 'changed', semanticType: 'heading' } },
        { id: sh.id, patch: { label: 'L', $unset: ['groupId'] } },
      ],
    }])
    // patch then unset in sequence
    roundTrip(d, [
      { type: 'updateObjects', pageId: P, patches: [{ id: t.id, patch: { groupId: 'g1' } }] },
      { type: 'updateObjects', pageId: P, patches: [{ id: t.id, patch: { $unset: ['groupId', 'align'] } }] },
    ], false)
  })

  it('multi-op sequences depending on each other', () => {
    const { d, P } = setup()
    const n = stroke()
    roundTrip(d, [
      { type: 'addObjects', pageId: P, objects: [n] },
      { type: 'updateObjects', pageId: P, patches: [{ id: n.id, patch: { z: 100 } }] },
      { type: 'deleteObjects', pageId: P, ids: [n.id] },
    ], false)
  })

  it('page ops', () => {
    const { d, P, p2 } = setup()
    roundTrip(d, [{ type: 'addPage', page: createPage({ order: 3, now: 9 }) }])
    roundTrip(d, [{ type: 'updatePage', pageId: p2.id, patch: { title: 'New', order: 7, width: undefined } }])
    roundTrip(d, [{ type: 'updatePage', pageId: P, patch: { width: 300, height: 400, kind: 'fixed', format: 'Custom' } }])
    roundTrip(d, [{ type: 'deletePage', pageId: p2.id }])
    roundTrip(d, [{ type: 'deletePage', pageId: P }])
  })

  it('recognition ops', () => {
    const { d, P, s2 } = setup()
    const existing = d.recognitions(P)[0]
    roundTrip(d, [{ type: 'setRecognitions', pageId: P, recognitions: [textRec('new', 1, 1, 5, 5, [s2.id])] }])
    roundTrip(d, [{ type: 'setRecognitions', pageId: P, recognitions: [{ ...existing, refinedText: 'refined' }] }])
    roundTrip(d, [{ type: 'deleteRecognitions', pageId: P, ids: [existing.id] }])
  })

  it('meta ops incl. absent toolSettings', () => {
    const { d } = setup()
    roundTrip(d, [{ type: 'updateMeta', patch: { title: 'Other', tags: ['x', 'y'], updatedAt: 99 } }])
    roundTrip(d, [{ type: 'updateMeta', patch: { toolSettings: { pen: { tool: 'pen', color: '#f00', width: 1, opacity: 1, pressureSensitive: true }, highlighter: { tool: 'highlighter', color: '#ff0', width: 10, opacity: 0.3, pressureSensitive: false }, shape: shape(0, 0).style, eraserSize: 10 } } }])
  })

  it('arrows with bindings', () => {
    const { d, P, sh } = setup()
    roundTrip(d, [{ type: 'addObjects', pageId: P, objects: [arrow({ startBinding: { objectId: sh.id, anchor: { x: 0.5, y: 1 } } })] }])
  })
})
