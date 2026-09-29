import { NotebookDocument } from '@folio/document'
import { describe, expect, it } from 'vitest'
import { addRaw, arrow, ink, objs, setup, shape, text } from './helpers'

describe('execute / undo / redo', () => {
  it('round trips add, update, delete', () => {
    const h = setup()
    const ed = h.editor
    ed.execute([{ type: 'addObjects', pageId: h.pageId, objects: [shape('a', 0, 0)] }])
    expect(ed.canUndo).toBe(true)
    ed.updateObjects([{ id: 'a', patch: { width: 300 } }])
    ed.deleteObjects(['a'])
    expect(objs(h)).toHaveLength(0)
    ed.undo()
    expect(objs(h)).toHaveLength(1)
    ed.undo()
    expect((h.doc.object(h.pageId, 'a') as { width: number }).width).toBe(100)
    ed.undo()
    expect(objs(h)).toHaveLength(0)
    expect(ed.canUndo).toBe(false)
    expect(ed.canRedo).toBe(true)
    ed.redo(); ed.redo(); ed.redo()
    expect(objs(h)).toHaveLength(0)
    expect(ed.canRedo).toBe(false)
  })

  it('reports ops for every commit including undo/redo, and clears redo on new commit', () => {
    const h = setup()
    h.editor.addObjects([shape('a', 0, 0)])
    h.editor.undo()
    h.editor.redo()
    expect(h.ops).toHaveLength(3)
    h.editor.undo()
    h.editor.addObjects([shape('b', 0, 0)])
    expect(h.editor.canRedo).toBe(false)
  })

  it('undoable:false skips history; coalesceKey merges into one step', () => {
    const h = setup()
    h.editor.addObjects([shape('a', 0, 0)])
    h.editor.execute([{ type: 'updateObjects', pageId: h.pageId, patches: [{ id: 'a', patch: { width: 5 } }] }], { undoable: false })
    h.editor.undo()
    expect(objs(h)).toHaveLength(0) // only the add was recorded
    h.editor.redo()
    for (let i = 0; i < 3; i++) {
      h.editor.execute([{ type: 'updateObjects', pageId: h.pageId, patches: [{ id: 'a', patch: { width: 10 + i } }] }], { coalesceKey: 'k' })
    }
    h.editor.undo()
    expect((h.doc.object(h.pageId, 'a') as { width: number }).width).toBe(100)
  })

  it('limits history to 500', () => {
    const h = setup()
    for (let i = 0; i < 510; i++) h.editor.execute([{ type: 'updateMeta', patch: { title: 't' + i } }])
    let n = 0
    while (h.editor.undo()) n++
    expect(n).toBe(500)
  })

  it('remote changes never enter the undo stack; undo skips remotely deleted targets', () => {
    const h = setup()
    h.editor.addObjects([shape('a', 0, 0), shape('b', 50, 50)])
    h.editor.updateObjects([{ id: 'a', patch: { width: 200 } }, { id: 'b', patch: { width: 200 } }])
    // simulate a remote peer deleting b
    const remote = NotebookDocument.empty(h.doc.id, { peerId: 7 })
    remote.importUpdates(h.doc.exportSnapshot())
    remote.apply([{ type: 'deleteObjects', pageId: h.pageId, ids: ['b'] }])
    h.doc.importUpdates(remote.exportUpdates(h.doc.version()))
    expect(h.doc.object(h.pageId, 'b')).toBeUndefined()
    const before = h.ops.length
    expect(h.editor.indexedIds()).toEqual(['a'])
    h.editor.undo() // reverts widths; b is gone → skipped gracefully
    expect((h.doc.object(h.pageId, 'a') as { width: number }).width).toBe(100)
    expect(h.doc.object(h.pageId, 'b')).toBeUndefined()
    expect(h.ops.length).toBe(before + 1)
    // remote-only change left the stack alone
    const h2 = setup()
    const r2 = NotebookDocument.empty(h2.doc.id, { peerId: 9 })
    r2.importUpdates(h2.doc.exportSnapshot())
    r2.apply([{ type: 'addObjects', pageId: h2.pageId, objects: [shape('r', 0, 0)] }])
    h2.doc.importUpdates(r2.exportUpdates(h2.doc.version()))
    expect(h2.editor.canUndo).toBe(false)
    expect(h2.editor.indexedIds()).toEqual(['r'])
  })

  it('cleanup and restoreInk are single undoable commits', () => {
    const h = setup()
    addRaw(h, [ink('s1', [[0, 0], [10, 0]]), ink('s2', [[0, 5], [10, 5]])])
    const ids = h.editor.applyCleanup([{ kind: 'text', sourceStrokeIds: ['s1', 's2'], object: { text: 'hi', fontSize: 20 } }])
    expect(ids).toHaveLength(1)
    expect((h.doc.object(h.pageId, 's1') as { supersededBy?: string }).supersededBy).toBe(ids[0])
    expect(h.doc.object(h.pageId, ids[0])).toMatchObject({ type: 'text', text: 'hi', sourceStrokeIds: ['s1', 's2'] })
    expect(h.editor.indexedIds()).toEqual([ids[0]])
    h.editor.undo()
    expect(h.doc.object(h.pageId, ids[0])).toBeUndefined()
    expect((h.doc.object(h.pageId, 's1') as { supersededBy?: string }).supersededBy).toBeUndefined()
    expect(h.editor.indexedIds().sort()).toEqual(['s1', 's2'])
    h.editor.redo()
    // restore ink from derived object
    h.editor.restoreInk([ids[0]])
    expect(h.doc.object(h.pageId, ids[0])).toBeUndefined()
    expect((h.doc.object(h.pageId, 's2') as { supersededBy?: string }).supersededBy).toBeUndefined()
    h.editor.undo() // undo restore → derived again
    expect(h.doc.object(h.pageId, ids[0])).toBeDefined()
    expect(h.editor.indexedIds()).toEqual([ids[0]])
  })

  it('arrow cleanup binds endpoints to nearby objects', () => {
    const h = setup()
    addRaw(h, [shape('box1', 0, 0, 100, 60), shape('box2', 300, 0, 100, 60), ink('s', [[0, 0], [10, 0]], 120, 30)])
    const [id] = h.editor.applyCleanup([{
      kind: 'arrow', sourceStrokeIds: ['s'],
      object: { start: { x: 104, y: 30 }, end: { x: 296, y: 30 }, endHead: 'arrow' },
    }])
    expect(h.doc.object(h.pageId, id)).toMatchObject({ startBinding: { objectId: 'box1' }, endBinding: { objectId: 'box2' } })
  })

  it('text-derived objects and ignoring unknown source strokes', () => {
    const h = setup()
    addRaw(h, [text('t', 0, 0)])
    expect(h.editor.applyCleanup([{ kind: 'text', sourceStrokeIds: ['nope'], object: { text: 'x' } }])).toEqual([])
    expect(h.editor.canUndo).toBe(false)
  })
})

describe('setSelectionStyle', () => {
  it('restyles ink, shape, arrow and text in one undoable commit', () => {
    const h = setup()
    const ed = h.editor
    addRaw(h, [ink('i', [[0, 0], [5, 5]]), shape('s', 50, 50), arrow('a', 0, 0, 40, 40), text('t', 10, 10), shape('other', 300, 300)])
    ed.select(['i', 's', 'a', 't'])
    const before = h.ops.length
    expect(ed.setSelectionStyle({ color: '#ff0000', width: 9, opacity: 0.5 })).toBe(4)
    expect(h.ops.length).toBe(before + 1)
    const o = (id: string) => h.doc.object(h.pageId, id) as any
    expect(o('i').style).toMatchObject({ color: '#ff0000', width: 9, opacity: 0.5, tool: expect.anything() })
    expect(o('s').style).toMatchObject({ strokeColor: '#ff0000', strokeWidth: 9, opacity: 0.5, roughness: 0 })
    expect(o('a').style).toMatchObject({ strokeColor: '#ff0000', strokeWidth: 9, opacity: 0.5 })
    expect(o('t').color).toBe('#ff0000')
    expect(o('other').style.strokeColor).toBe('#000') // not selected
    ed.undo()
    expect(o('i').style.color).not.toBe('#ff0000')
    expect(o('s').style.strokeWidth).toBe(2)
    expect(o('t').color).toBe('#000')
    ed.redo()
    expect(o('s').style.strokeColor).toBe('#ff0000')
  })

  it('does nothing without a selection or when values are unchanged', () => {
    const h = setup()
    addRaw(h, [shape('s', 0, 0)])
    expect(h.editor.setSelectionStyle({ color: '#f00' })).toBe(0)
    h.editor.select(['s'])
    expect(h.editor.setSelectionStyle({ color: '#000', width: 2 })).toBe(0)
    expect(h.editor.canUndo).toBe(false)
  })

  it('applies to the members of a selected group', () => {
    const h = setup()
    addRaw(h, [shape('a', 0, 0), shape('b', 200, 0)])
    h.editor.select(['a', 'b'])
    h.editor.groupSelection()
    expect(h.editor.setSelectionStyle({ width: 7 })).toBe(2)
    expect((h.doc.object(h.pageId, 'b') as any).style.strokeWidth).toBe(7)
  })
})
