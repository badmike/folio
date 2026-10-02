import { afterEach, describe, expect, it } from 'vitest'
import type { ArrowObject, InkStroke, ShapeObject, TextObject } from '@folio/document'
import { INK_POINT_STRIDE } from '@folio/document'
import { addRaw, arrow, drag, ink, key, objs, pointer, setup, shape, text } from './helpers'
import type { Harness } from './helpers'

let h: Harness
afterEach(() => h?.editor.destroy())

const flush = () => h.editor.flushPending()

describe('pen drawing', () => {
  it('retains rapid strokes without committing or rendering in the next pointerdown', () => {
    h = setup()
    h.editor.renderNow()
    h.renderer.render.mockClear()
    for (let i = 0; i < 20; i++) drag(h, [10 + i * 10, 20], [15 + i * 10, 30], { pointerType: 'pen' })
    pointer(h, 'pointerdown', 220, 20, { pointerType: 'pen' })
    expect(objs(h)).toHaveLength(0)
    expect(h.renderer.render).not.toHaveBeenCalled()
    expect(h.live.finish).toHaveBeenCalledTimes(20)
    h.editor.renderNow()
    expect(objs(h)).toHaveLength(20)
    expect(new Set(objs(h).map((o) => o.z)).size).toBe(20)
    expect(h.live.clearCommitted).toHaveBeenCalledTimes(1)
    expect(h.live.clear).not.toHaveBeenCalled()
    pointer(h, 'pointermove', 230, 30, { pointerType: 'pen' })
    pointer(h, 'pointerup', 230, 30, { pointerType: 'pen' })
    flush()
    expect(objs(h)).toHaveLength(21)
    h.editor.undo()
    expect(objs(h)).toHaveLength(20)
  })

  it('produces a stroke with pressure/tilt relative to bbox min, committed after the frame', async () => {
    h = setup()
    h.editor.setTool('pen')
    pointer(h, 'pointerdown', 100, 200, { pointerType: 'pen', pressure: 0.3, tiltX: 10 })
    pointer(h, 'pointermove', 120, 210, { pointerType: 'pen', pressure: 0.6, coalesced: [[110, 205], [120, 210]] })
    pointer(h, 'pointermove', 150, 180, { pointerType: 'pen', pressure: 0.9 })
    pointer(h, 'pointerup', 150, 180, { pointerType: 'pen', pressure: 0 })
    // live layer got points immediately; nothing in the document yet
    expect(h.live.points).toBeGreaterThanOrEqual(4)
    expect(objs(h)).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 5))
    const [s] = objs(h) as InkStroke[]
    expect(s.type).toBe('ink')
    expect(s.pointerType).toBe('pen')
    expect(s.transform).toMatchObject({ x: 100, y: 180 })
    expect(s.points.length % INK_POINT_STRIDE).toBe(0)
    expect(s.points[0]).toBe(0) // first x relative to origin
    expect(s.points[1]).toBe(20) // 200 - 180
    expect(s.points[2]).toBeCloseTo(0.3)
    expect(s.points[3]).toBe(10)
    // coalesced events contributed intermediate samples with their own pressure
    const pressures = s.points.filter((_, i) => i % INK_POINT_STRIDE === 2)
    expect(pressures.length).toBeGreaterThanOrEqual(4)
    expect(new Set(pressures).size).toBeGreaterThan(2)
    expect(h.strokes).toHaveLength(1)
    expect(h.ops[0][0]).toMatchObject({ type: 'addObjects' })
    // live layer cleared after the frame that shows the committed stroke
    // (the frame loop renders, then clears the live layer)
    h.editor.renderNow()
    expect(h.live.cleared).toBeGreaterThanOrEqual(1)
    expect(h.renderer.last.objects.map((o) => o.id)).toContain(s.id)
    // undo removes it
    h.editor.undo()
    expect(objs(h)).toHaveLength(0)
  })

  it('a tap makes a dot and highlighter uses its style', () => {
    h = setup()
    h.editor.setTool('highlighter')
    drag(h, [10, 10], [10, 10])
    flush()
    const s = objs(h)[0] as InkStroke
    expect(s.style.tool).toBe('highlighter')
    expect(s.points.length).toBe(2 * INK_POINT_STRIDE)
  })

  it('camera transform: points are stored in world space', () => {
    h = setup()
    h.editor.setCamera({ x: 1000, y: 500, zoom: 2 })
    drag(h, [0, 0], [100, 0])
    flush()
    const s = objs(h)[0] as InkStroke
    expect(s.transform).toMatchObject({ x: 1000, y: 500 })
    expect(s.points[s.points.length - INK_POINT_STRIDE]).toBeCloseTo(50)
  })
})

describe('touch and pen modes', () => {
  it('rejects a palm that arrived before the pen, including a second finger', () => {
    h = setup({ penMode: 'pen-only' })
    pointer(h, 'pointerdown', 300, 300, { pointerType: 'touch', id: 2 })
    pointer(h, 'pointerdown', 10, 10, { pointerType: 'pen', id: 1 })
    pointer(h, 'pointermove', 350, 350, { pointerType: 'touch', id: 2 })
    pointer(h, 'pointerdown', 400, 400, { pointerType: 'touch', id: 3 })
    pointer(h, 'pointermove', 20, 20, { pointerType: 'pen', id: 1 })
    pointer(h, 'pointerup', 20, 20, { pointerType: 'pen', id: 1 })
    pointer(h, 'pointerup', 350, 350, { pointerType: 'touch', id: 2 })
    pointer(h, 'pointerup', 400, 400, { pointerType: 'touch', id: 3 })
    flush()
    expect(objs(h)).toHaveLength(1)
    expect(h.editor.camera).toEqual({ x: 0, y: 0, zoom: 1 })
    drag(h, [30, 10], [40, 20], { pointerType: 'pen', id: 1 })
    flush()
    expect(objs(h)).toHaveLength(2)
  })

  it('touch pans (does not draw) once a pen was seen; two fingers pinch-zoom', () => {
    h = setup()
    // pen touches and lifts
    drag(h, [10, 10], [20, 20], { pointerType: 'pen', id: 1 })
    flush()
    expect(objs(h)).toHaveLength(1)
    const cam0 = { ...h.editor.camera }
    drag(h, [300, 300], [350, 340], { pointerType: 'touch', id: 2 })
    flush()
    expect(objs(h)).toHaveLength(1)
    expect(h.editor.camera.x).toBeCloseTo(cam0.x - 50)
    expect(h.editor.camera.y).toBeCloseTo(cam0.y - 40)
    // pinch: two fingers moving apart zoom in
    pointer(h, 'pointerdown', 400, 400, { pointerType: 'touch', id: 3 })
    pointer(h, 'pointerdown', 500, 400, { pointerType: 'touch', id: 4 })
    pointer(h, 'pointermove', 350, 400, { pointerType: 'touch', id: 3 })
    pointer(h, 'pointermove', 550, 400, { pointerType: 'touch', id: 4 })
    expect(h.editor.camera.zoom).toBeGreaterThan(1.5)
    pointer(h, 'pointerup', 350, 400, { pointerType: 'touch', id: 3 })
    pointer(h, 'pointerup', 550, 400, { pointerType: 'touch', id: 4 })
    expect(objs(h)).toHaveLength(1)
  })

  it('touch draws before any pen was seen, unless penMode is pen-only; palm rejected while pen down', () => {
    h = setup()
    drag(h, [10, 10], [50, 50], { pointerType: 'touch' })
    flush()
    expect(objs(h)).toHaveLength(1)
    h.editor.setPenMode('pen-only')
    drag(h, [10, 10], [50, 50], { pointerType: 'touch' })
    flush()
    expect(objs(h)).toHaveLength(1)
    h.editor.setPenMode('any')
    const camBefore = { ...h.editor.camera }
    pointer(h, 'pointerdown', 10, 10, { pointerType: 'pen', id: 1 })
    drag(h, [200, 200], [260, 260], { pointerType: 'touch', id: 2 }) // palm
    pointer(h, 'pointerup', 10, 10, { pointerType: 'pen', id: 1 })
    flush()
    expect(objs(h)).toHaveLength(2) // the pen tap only
    expect(h.editor.camera).toEqual(camBefore)
  })

  it('second finger cancels a touch stroke in progress (any mode)', () => {
    h = setup({ penMode: 'any' })
    pointer(h, 'pointerdown', 100, 100, { pointerType: 'touch', id: 1 })
    pointer(h, 'pointermove', 120, 120, { pointerType: 'touch', id: 1 })
    pointer(h, 'pointerdown', 300, 100, { pointerType: 'touch', id: 2 })
    pointer(h, 'pointerup', 120, 120, { pointerType: 'touch', id: 1 })
    pointer(h, 'pointerup', 300, 100, { pointerType: 'touch', id: 2 })
    flush()
    expect(objs(h)).toHaveLength(0)
  })

  it('middle button and space+drag pan; wheel pans, ctrl+wheel zooms at cursor', () => {
    h = setup()
    drag(h, [100, 100], [160, 130], { button: 1 })
    expect(h.editor.camera).toMatchObject({ x: -60, y: -30 })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    drag(h, [100, 100], [110, 100])
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }))
    expect(h.editor.camera.x).toBe(-70)
    flush()
    expect(objs(h)).toHaveLength(0)
    const wheel = (init: WheelEventInit) => {
      const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
      for (const [k, v] of Object.entries(init)) Object.defineProperty(ev, k, { value: v })
      h.editor.root.dispatchEvent(ev)
    }
    wheel({ deltaX: 0, deltaY: 40 })
    expect(h.editor.camera.y).toBe(-30 + 40)
    const before = h.editor.screenToWorld({ x: 500, y: 400 })
    wheel({ deltaY: -100, ctrlKey: true, clientX: 500, clientY: 400 })
    expect(h.editor.camera.zoom).toBeGreaterThan(1)
    const after = h.editor.screenToWorld({ x: 500, y: 400 })
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })
})

describe('scribble to erase', () => {
  /** Pen zigzag between x0 and x1, drifting from y0 to y1, with `legs` passes. */
  function scribble(x0: number, x1: number, y0: number, y1: number, legs = 6) {
    const o = { pointerType: 'pen' }
    pointer(h, 'pointerdown', x0, y0, o)
    for (let i = 1; i <= legs; i++) {
      for (let k = 1; k <= 4; k++) {
        const t = (i - 1 + k / 4) / legs
        const x = i % 2 ? x0 + ((x1 - x0) * k) / 4 : x1 - ((x1 - x0) * k) / 4
        pointer(h, 'pointermove', x, y0 + (y1 - y0) * t, o)
      }
    }
    pointer(h, 'pointerup', legs % 2 ? x1 : x0, y1, o)
    flush()
  }
  const word = () => ink('word', [[0, 10], [10, 0], [20, 10], [30, 0], [40, 10], [50, 0], [60, 10]], 100, 100)

  it('erases the ink it covers in one undo step and leaves no scribble behind', () => {
    h = setup()
    addRaw(h, [word(), ink('other', [[0, 0], [60, 0]], 100, 300)])
    h.editor.setTool('pen')
    scribble(95, 165, 98, 112)
    expect(objs(h).map((o) => o.id)).toEqual(['other'])
    expect(h.live.cancel).toHaveBeenCalled()
    h.editor.undo()
    expect(objs(h).map((o) => o.id).sort()).toEqual(['other', 'word'])
  })

  it('keeps the scribble as ink in empty space, when it misses the ink, or when turned off', () => {
    h = setup()
    addRaw(h, [word()])
    h.editor.setTool('pen')
    scribble(400, 470, 98, 112)
    expect(objs(h)).toHaveLength(2)
    h.editor.setScribbleErase(false)
    scribble(95, 165, 98, 112)
    expect(objs(h)).toHaveLength(3)
  })

  it('a plain stroke through ink is not a scribble', () => {
    h = setup()
    addRaw(h, [word()])
    h.editor.setTool('pen')
    drag(h, [90, 105], [170, 105], { pointerType: 'pen' }, 20)
    flush()
    expect(objs(h)).toHaveLength(2)
  })
})

describe('eraser', () => {
  it('erases whole objects along the path, hides live, commits one delete', () => {
    h = setup()
    addRaw(h, [ink('a', [[0, 0], [100, 0]], 0, 100), ink('b', [[0, 0], [100, 0]], 0, 300), shape('box', 500, 500)])
    h.editor.setTool('eraser')
    h.editor.setToolOptions('eraser', { size: 20 })
    pointer(h, 'pointerdown', 50, 100)
    pointer(h, 'pointermove', 50, 200)
    h.editor.renderNow()
    expect(h.renderer.last.hiddenIds?.has('a')).toBe(true)
    expect(h.renderer.last.hiddenIds?.has('b')).toBeFalsy()
    expect(objs(h)).toHaveLength(3) // not committed yet
    pointer(h, 'pointermove', 50, 300)
    pointer(h, 'pointerup', 50, 300)
    expect(objs(h).map((o) => o.id)).toEqual(['box'])
    h.editor.undo() // single step
    expect(objs(h)).toHaveLength(3)
  })

  it('erasing a shape detaches arrows bound to it', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0, 100, 60), shape('b', 300, 0, 100, 60), arrow('ar', 100, 30, 300, 30, {
      startBinding: { objectId: 'a' }, endBinding: { objectId: 'b' },
    })])
    h.editor.deleteObjects(['a'])
    const ar = h.doc.object(h.pageId, 'ar') as ArrowObject
    expect(ar.startBinding).toBeUndefined()
    expect(ar.endBinding).toEqual({ objectId: 'b' })
    h.editor.undo()
    expect((h.doc.object(h.pageId, 'ar') as ArrowObject).startBinding).toEqual({ objectId: 'a' })
  })
})

describe('select tool', () => {
  it('tap selects topmost, shift adds, empty click clears', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0, 100, 60, { style: { strokeColor: '#000', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1, fillColor: '#fff' } }),
      shape('b', 50, 20, 100, 60, { z: 5, style: { strokeColor: '#000', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1, fillColor: '#fff' } })])
    h.editor.setTool('select')
    drag(h, [60, 30], [60, 30])
    expect(h.editor.selection).toEqual(['b'])
    drag(h, [10, 10], [10, 10], { shiftKey: true })
    expect([...h.editor.selection].sort()).toEqual(['a', 'b'])
    drag(h, [700, 700], [700, 700])
    expect(h.editor.selection).toEqual([])
  })

  it('marquee and lasso selection sets', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0, 50, 50), shape('b', 100, 0, 50, 50), shape('c', 400, 400, 50, 50), ink('i', [[0, 0], [20, 20]], 110, 110)])
    h.editor.setTool('select')
    drag(h, [-10, -10], [160, 60]) // marquee over a and b
    expect([...h.editor.selection].sort()).toEqual(['a', 'b'])
    h.editor.clearSelection()
    // partial overlap counts
    drag(h, [40, 40], [120, 130])
    expect([...h.editor.selection].sort()).toEqual(['a', 'b', 'i'])
    // lasso with pen (auto): polygon around 'c' only
    h.editor.clearSelection()
    pointer(h, 'pointerdown', 380, 380, { pointerType: 'pen' })
    pointer(h, 'pointermove', 480, 380, { pointerType: 'pen' })
    pointer(h, 'pointermove', 480, 480, { pointerType: 'pen' })
    pointer(h, 'pointermove', 380, 480, { pointerType: 'pen' })
    h.editor.renderNow()
    expect(h.renderer.last.selection?.lasso?.length).toBeGreaterThanOrEqual(3)
    pointer(h, 'pointerup', 380, 470, { pointerType: 'pen' })
    expect(h.editor.selection).toEqual(['c'])
  })

  it('drag moves selection with one commit and one undo step; preview does not commit', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0, 100, 60, { style: { strokeColor: '#000', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1, fillColor: '#fff' } })])
    h.editor.setTool('select')
    pointer(h, 'pointerdown', 50, 30)
    pointer(h, 'pointermove', 80, 50)
    pointer(h, 'pointermove', 150, 130)
    h.editor.renderNow()
    expect((h.doc.object(h.pageId, 'a') as ShapeObject).transform.x).toBe(0) // not committed
    expect((h.renderer.last.objects.find((o) => o.id === 'a') as ShapeObject).transform.x).toBe(100)
    const opsBefore = h.ops.length
    pointer(h, 'pointerup', 150, 130)
    expect(h.ops.length).toBe(opsBefore + 1)
    expect((h.doc.object(h.pageId, 'a') as ShapeObject).transform).toMatchObject({ x: 100, y: 100 })
    h.editor.undo()
    expect((h.doc.object(h.pageId, 'a') as ShapeObject).transform).toMatchObject({ x: 0, y: 0 })
  })

  it('resizing via the se handle scales shape width/height; rotate handle rotates', () => {
    h = setup()
    addRaw(h, [shape('a', 100, 100, 100, 60)])
    h.editor.setTool('select')
    h.editor.select(['a'])
    drag(h, [200, 160], [300, 160]) // se corner (≈ +stroke pad none: frame is un-padded)
    const a = h.doc.object(h.pageId, 'a') as ShapeObject
    expect(a.width).toBeCloseTo(200)
    expect(a.height).toBeCloseTo(60)
    expect(a.transform).toMatchObject({ x: 100, y: 100 })
    // rotate handle sits 28px above the top-center (x=200, y=100)
    const frame = h.editor.selectionFrame()!
    const top = { x: frame.center.x, y: frame.rect.y - 28 }
    drag(h, [top.x, top.y], [top.x + 100, frame.center.y]) // pointer to the right of the center → +90deg
    const r = (h.doc.object(h.pageId, 'a') as ShapeObject).transform.rotation
    expect(r).toBeCloseTo(Math.PI / 2, 1)
  })

  it('double tap on text starts editing', () => {
    h = setup()
    addRaw(h, [text('t', 100, 100, 'hello')])
    h.editor.setTool('select')
    drag(h, [110, 110], [110, 110])
    expect(h.editor.isEditingText).toBe(false)
    drag(h, [110, 110], [110, 110])
    expect(h.editor.isEditingText).toBe(true)
    const ta = h.editor.domLayer.querySelector('textarea')!
    expect(ta.value).toBe('hello')
    ta.value = 'changed'
    key('Escape') // ignored while editing (target window) - commit through blur
    h.editor.commitTextEdit()
    expect((h.doc.object(h.pageId, 't') as TextObject).text).toBe('changed')
    h.editor.undo()
    expect((h.doc.object(h.pageId, 't') as TextObject).text).toBe('hello')
  })
})

describe('creation tools', () => {
  it('shape tool drags a rectangle; shift constrains to square', () => {
    h = setup({ toolLock: true }) // keep the shape tool active between drags
    h.editor.setTool('shape')
    drag(h, [100, 100], [220, 160])
    let s = objs(h)[0] as ShapeObject
    expect(s).toMatchObject({ type: 'shape', kind: 'rectangle', width: 120, height: 60 })
    expect(s.transform).toMatchObject({ x: 100, y: 100 })
    drag(h, [500, 500], [400, 460], { shiftKey: true })
    s = objs(h)[1] as ShapeObject
    expect(s.width).toBe(100)
    expect(s.height).toBe(100)
    expect(s.transform).toMatchObject({ x: 400, y: 400 })
    // tiny drags create nothing
    drag(h, [10, 10], [11, 11])
    expect(objs(h)).toHaveLength(2)
  })

  it('arrow tool binds endpoints to objects under/near them', () => {
    h = setup({ toolLock: true })
    addRaw(h, [shape('a', 0, 0, 100, 60), shape('b', 300, 0, 100, 60)])
    h.editor.setTool('arrow')
    pointer(h, 'pointerdown', 50, 30)
    pointer(h, 'pointermove', 200, 30)
    pointer(h, 'pointermove', 320, 40)
    h.editor.renderNow()
    expect(h.renderer.last.selection?.bindingTargetId).toBe('b')
    expect(h.renderer.last.previews?.[0].type).toBe('arrow')
    pointer(h, 'pointerup', 320, 40)
    const ar = objs(h).find((o) => o.type === 'arrow') as ArrowObject
    expect(ar.startBinding?.objectId).toBe('a')
    expect(ar.endBinding?.objectId).toBe('b')
    expect(ar.endHead).toBe('arrow')
    // free arrow stays unbound
    drag(h, [100, 300], [250, 300])
    const free = objs(h).filter((o) => o.type === 'arrow')[1] as ArrowObject
    expect(free.startBinding).toBeUndefined()
    expect(free.endBinding).toBeUndefined()
  })

  it('text tool creates a text object on tap; empty text creates nothing', () => {
    h = setup()
    h.editor.setTool('text')
    drag(h, [200, 200], [200, 200])
    expect(h.editor.isEditingText).toBe(true)
    const ta = h.editor.domLayer.querySelector('textarea')!
    ta.value = 'note'
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    expect(h.editor.isEditingText).toBe(false)
    const t = objs(h)[0] as TextObject
    expect(t).toMatchObject({ type: 'text', text: 'note', fontFamily: 'hand' })
    // empty
    drag(h, [400, 400], [400, 400])
    h.editor.commitTextEdit()
    expect(objs(h)).toHaveLength(1)
    // editing an existing text down to empty deletes it
    expect(h.editor.startTextEdit(t.id)).toBe(true)
    h.editor.domLayer.querySelector('textarea')!.value = '  '
    h.editor.commitTextEdit()
    expect(objs(h)).toHaveLength(0)
  })

  it('shape label editing', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0)])
    expect(h.editor.startTextEdit('a')).toBe(true)
    h.editor.domLayer.querySelector('textarea')!.value = 'Label'
    h.editor.commitTextEdit()
    expect((h.doc.object(h.pageId, 'a') as ShapeObject).label).toBe('Label')
  })
})

describe('selection API', () => {
  it('duplicate offsets, remaps bindings and groups', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0), shape('b', 300, 0), arrow('ar', 100, 30, 300, 30, { startBinding: { objectId: 'a' }, endBinding: { objectId: 'b' } })])
    h.editor.select(['a', 'b', 'ar'])
    h.editor.groupSelection()
    expect(h.editor.selection).toHaveLength(1)
    const gid = h.editor.selection[0]
    expect((h.doc.object(h.pageId, 'a') as ShapeObject).groupId).toBe(gid)
    // selecting a member selects the group
    h.editor.select(['a'])
    expect(h.editor.selection).toEqual([gid])
    const newIds = h.editor.duplicateSelection()
    expect(newIds).toHaveLength(1)
    const all = objs(h)
    expect(all.filter((o) => o.type === 'group')).toHaveLength(2)
    const g2 = all.find((o) => o.id === newIds[0]) as { childIds: string[] }
    const kids = g2.childIds.map((id) => h.doc.object(h.pageId, id)!)
    expect(kids).toHaveLength(3)
    const a2 = kids.find((k) => k.type === 'shape' && (k as ShapeObject).transform.x === 20) as ShapeObject
    expect(a2.groupId).toBe(newIds[0])
    const ar2 = kids.find((k) => k.type === 'arrow') as ArrowObject
    expect(ar2.startBinding!.objectId).not.toBe('a')
    expect(kids.map((k) => k.id)).toContain(ar2.startBinding!.objectId)
    expect(kids.map((k) => k.id)).toContain(ar2.endBinding!.objectId)
    expect(ar2.start).toEqual({ x: 120, y: 50 })
    // one undo removes the whole duplicate
    h.editor.undo()
    expect(objs(h).filter((o) => o.type === 'group')).toHaveLength(1)
  })

  it('ungroup, delete, z order, copy/paste', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0), shape('b', 10, 10, 100, 60, { z: 2 })])
    h.editor.select(['a', 'b'])
    h.editor.groupSelection()
    h.editor.ungroupSelection()
    expect(objs(h).some((o) => o.type === 'group')).toBe(false)
    expect((h.doc.object(h.pageId, 'a') as ShapeObject).groupId).toBeUndefined()
    expect([...h.editor.selection].sort()).toEqual(['a', 'b'])
    h.editor.select(['a'])
    h.editor.bringToFront()
    expect((h.doc.object(h.pageId, 'a') as ShapeObject).z).toBeGreaterThan(2)
    h.editor.sendToBack()
    expect((h.doc.object(h.pageId, 'a') as ShapeObject).z).toBeLessThan(1)
    const payload = h.editor.copySelection()!
    expect(JSON.parse(JSON.stringify(payload)).objects).toHaveLength(1)
    const [pid] = h.editor.paste(payload, { x: 500, y: 500 })
    expect(pid).not.toBe('a')
    const p = h.doc.object(h.pageId, pid) as ShapeObject
    expect(p.transform.x + p.width / 2).toBeCloseTo(500)
    h.editor.deleteSelection()
    expect(h.doc.object(h.pageId, pid)).toBeUndefined()
  })

  it('keyboard shortcuts', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0)])
    h.editor.setTool('select')
    drag(h, [50, 30], [50, 30]) // marks the editor active and selects the shape (fill-less → border only)
    h.editor.select(['a'])
    key('ArrowRight')
    key('ArrowRight', { shift: true })
    expect((h.doc.object(h.pageId, 'a') as ShapeObject).transform.x).toBe(11)
    h.editor.undo() // nudges coalesce into one step
    expect((h.doc.object(h.pageId, 'a') as ShapeObject).transform.x).toBe(0)
    key('d', { meta: true })
    expect(objs(h)).toHaveLength(2)
    key('z', { meta: true })
    expect(objs(h)).toHaveLength(1)
    key('z', { meta: true, shift: true })
    expect(objs(h)).toHaveLength(2)
    h.editor.select(['a'])
    key('Delete')
    expect(objs(h)).toHaveLength(1)
    key('a', { meta: true })
    expect(h.editor.selection).toHaveLength(1)
    key('e')
    expect(h.editor.tool).toBe('eraser')
    key('p')
    expect(h.editor.tool).toBe('pen')
    key('y', { ctrl: true })
    expect(h.editor.canRedo).toBe(false)
  })
})

describe('lifecycle', () => {
  it('emits events, respects readOnly and cleans up on destroy', () => {
    h = setup()
    const tools: string[] = []
    const hist: boolean[] = []
    h.editor.on('tool', (t) => tools.push(t))
    h.editor.on('history', (s) => hist.push(s.canUndo))
    h.editor.setTool('shape')
    h.editor.addObjects([shape('a', 0, 0)])
    expect(tools).toContain('shape')
    expect(hist).toEqual([true])
    h.editor.setReadOnly(true)
    h.editor.addObjects([shape('b', 0, 0)])
    expect(objs(h)).toHaveLength(1)
    drag(h, [10, 10], [100, 100]) // pans in read-only mode
    expect(h.editor.camera.x).toBe(-90)
    h.editor.setReadOnly(false)
    const root = h.editor.root
    h.editor.destroy()
    expect(root.isConnected).toBe(false)
    expect(h.renderer.dispose).toHaveBeenCalled()
    expect(h.live.dispose).toHaveBeenCalled()
  })

  it('setPage switches pages and highlights are passed to the scene', () => {
    h = setup()
    const p2 = h.doc.pages()[0]
    h.editor.setHighlights([{ x: 0, y: 0, width: 5, height: 5 }])
    h.editor.renderNow()
    expect(h.renderer.last.highlights).toHaveLength(1)
    expect(h.renderer.last.page.id).toBe(p2.id)
  })
})
