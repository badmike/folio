import { afterEach, describe, expect, it } from 'vitest'
import type { ArrowObject } from '@folio/document'
import { addRaw, arrow, drag, objs, pointer, setup, shape } from './helpers'
import type { Harness } from './helpers'

let h: Harness
afterEach(() => h?.editor.destroy())
const get = (id: string) => h.doc.object(h.pageId, id) as ArrowObject

describe('arrow tool uses itemStyle', () => {
  it('creates arrows with the current arrowType, heads, stroke style', () => {
    h = setup()
    h.editor.setItemStyle({ arrowType: 'curved', endHead: 'triangle', startHead: 'dot', strokeStyle: 'dashed', strokeColor: '#e03131' })
    h.editor.setTool('arrow')
    drag(h, [100, 100], [300, 200])
    const a = objs(h).find((o) => o.type === 'arrow') as ArrowObject
    expect(a.arrowType).toBe('curved')
    expect(a.endHead).toBe('triangle')
    expect(a.startHead).toBe('dot')
    expect(a.style).toMatchObject({ strokeStyle: 'dashed', strokeColor: '#e03131' })
    expect(a.style.fillColor).toBeUndefined()
  })

  it('shape tool applies fill colour / style from itemStyle', () => {
    h = setup()
    h.editor.setItemStyle({ backgroundColor: '#a5d8ff', fillStyle: 'cross-hatch', roughness: 2, opacity: 0.5 })
    h.editor.setTool('shape')
    drag(h, [100, 100], [200, 180])
    const s = objs(h).find((o) => o.type === 'shape') as any
    expect(s.style).toMatchObject({ fillColor: '#a5d8ff', fillStyle: 'cross-hatch', roughness: 2, opacity: 0.5 })
  })
})

describe('curved arrow editing', () => {
  it('shows start/end/virtual handles for a selected arrow (select tool only)', () => {
    h = setup()
    addRaw(h, [arrow('a', 100, 100, 400, 100, { arrowType: 'curved' })])
    h.editor.setTool('select')
    h.editor.select(['a'])
    h.editor.renderNow()
    const handles = h.renderer.last.selection!.arrowHandles!
    expect(handles.map((x) => x.id)).toEqual(['start', 'end', 'v:0'])
    h.editor.select([])
    h.editor.renderNow()
    expect(h.renderer.last.selection?.arrowHandles).toBeUndefined()
  })

  it('dragging the virtual handle creates a waypoint (one undo step); dragging a waypoint moves it', () => {
    h = setup()
    addRaw(h, [arrow('a', 100, 100, 400, 100, { arrowType: 'curved' })])
    h.editor.setTool('select')
    h.editor.select(['a'])
    drag(h, [250, 100], [250, 40])
    expect(get('a').waypoints).toEqual([{ x: 250, y: 40 }])
    expect(h.editor.canUndo).toBe(true)
    // move it
    drag(h, [250, 40], [260, 0])
    expect(get('a').waypoints).toEqual([{ x: 260, y: 0 }])
    h.editor.undo()
    expect(get('a').waypoints).toEqual([{ x: 250, y: 40 }])
    h.editor.undo()
    expect(get('a').waypoints).toBeUndefined()
  })

  it('a plain tap on a virtual handle does not create a waypoint', () => {
    h = setup()
    addRaw(h, [arrow('a', 100, 100, 400, 100, { arrowType: 'curved' })])
    h.editor.setTool('select')
    h.editor.select(['a'])
    pointer(h, 'pointerdown', 250, 100)
    pointer(h, 'pointerup', 250, 100)
    expect(get('a').waypoints).toBeUndefined()
    expect(h.editor.canUndo).toBe(false)
  })

  it('double tap removes a waypoint', () => {
    h = setup()
    addRaw(h, [arrow('a', 100, 100, 400, 100, { arrowType: 'curved', waypoints: [{ x: 250, y: 40 }] })])
    h.editor.setTool('select')
    h.editor.select(['a'])
    for (let i = 0; i < 2; i++) {
      pointer(h, 'pointerdown', 250, 40)
      pointer(h, 'pointerup', 250, 40)
    }
    expect(get('a').waypoints).toBeUndefined()
    h.editor.undo()
    expect(get('a').waypoints).toEqual([{ x: 250, y: 40 }])
  })

  it('endpoint drag keeps waypoints and rebinding still works', () => {
    h = setup()
    addRaw(h, [shape('b', 500, 60, 100, 80), arrow('a', 100, 100, 400, 100, { arrowType: 'curved', waypoints: [{ x: 250, y: 40 }] })])
    h.editor.setTool('select')
    h.editor.select(['a'])
    drag(h, [400, 100], [550, 100])
    const a = get('a')
    expect(a.endBinding?.objectId).toBe('b')
    expect(a.waypoints).toEqual([{ x: 250, y: 40 }])
  })
})

describe('elbow arrow editing', () => {
  it('segment handles move a segment perpendicular and store waypoints; type change clears them', () => {
    h = setup()
    addRaw(h, [
      shape('s', 0, 0, 100, 60), shape('e', 400, 200, 100, 60),
      arrow('a', 50, 30, 450, 230, { arrowType: 'elbow', startBinding: { objectId: 's' }, endBinding: { objectId: 'e' } }),
    ])
    h.editor.setTool('select')
    h.editor.select(['a'])
    h.editor.renderNow()
    const vs = h.renderer.last.selection!.arrowHandles!.filter((x) => x.kind === 'virtual')
    expect(vs.length).toBeGreaterThan(0)
    // route is Z-shaped: right, down, right; the middle handle is the vertical segment
    const mid = vs[Math.floor(vs.length / 2)]
    const from: [number, number] = [mid.world.x, mid.world.y]
    drag(h, from, [from[0] + 60, from[1]])
    const a = get('a')
    expect(a.waypoints?.length).toBeGreaterThanOrEqual(2)
    expect(a.waypoints!.some((w) => Math.abs(w.x - (from[0] + 60)) < 1e-6)).toBe(true)
    h.editor.setStyle({ arrowType: 'curved' })
    expect(get('a').waypoints).toBeUndefined()
  })
})
