import { describe, expect, it } from 'vitest'
import { addRaw, arrow, ink, setup, shape, text } from './helpers'

const o = (h: ReturnType<typeof setup>, id: string) => h.doc.object(h.pageId, id) as any

describe('styleContext', () => {
  it('reports the active tool when nothing is selected', () => {
    const h = setup()
    const ed = h.editor
    ed.setTool('shape')
    let c = ed.styleContext()
    expect(c.source).toBe('tool')
    expect(c.applicable).toEqual(['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity'])
    expect(c.values.strokeColor).toBe('#1e1e1e')
    ed.setTool('arrow')
    c = ed.styleContext()
    expect(c.applicable).toContain('arrowType')
    expect(c.applicable).not.toContain('backgroundColor')
    ed.setTool('text')
    expect(ed.styleContext().applicable).toEqual(['strokeColor', 'fontFamily', 'fontSize', 'textAlign', 'opacity'])
    ed.setTool('pen')
    c = ed.styleContext()
    expect(c.applicable).toEqual(['strokeColor', 'strokeWidth', 'opacity'])
    expect(c.values.opacity).toBe(1)
    ed.setTool('eraser')
    expect(ed.styleContext().applicable).toEqual([])
    ed.setTool('select')
    expect(ed.styleContext().applicable).toEqual([])
    expect(c.canvasBackground).toBe(h.doc.page(h.pageId)!.background.color)
  })

  it('computes common values and mixed for a selection', () => {
    const h = setup()
    addRaw(h, [
      shape('a', 0, 0, 50, 50, { style: { strokeColor: '#f00', strokeWidth: 2, opacity: 1, roughness: 1, seed: 1, fillColor: '#0f0' } }),
      shape('b', 100, 0, 50, 50, { style: { strokeColor: '#f00', strokeWidth: 4, opacity: 1, roughness: 1, seed: 2 } }),
      text('t', 0, 100),
    ])
    h.editor.setTool('select')
    h.editor.select(['a', 'b'])
    let c = h.editor.styleContext()
    expect(c.source).toBe('selection')
    expect(c.types).toEqual(['shape'])
    expect(c.values.strokeColor).toBe('#f00')
    expect(c.values.strokeWidth).toBe('mixed')
    expect(c.values.backgroundColor).toBe('mixed')
    expect(c.values.strokeStyle).toBe('solid')
    h.editor.select(['a', 't'])
    c = h.editor.styleContext()
    expect(c.types.sort()).toEqual(['shape', 'text'])
    expect(c.applicable).toEqual(expect.arrayContaining(['backgroundColor', 'fontSize', 'textAlign']))
    expect(c.values.strokeColor).toBe('mixed')
    expect(c.values.fontSize).toBe(20)
  })

  it('maps ink width to the shared 1/2/4 preset scale', () => {
    const h = setup()
    addRaw(h, [ink('i', [[0, 0], [5, 5]], 0, 0, { style: { tool: 'pen', color: '#000', width: 4.5, opacity: 1, pressureSensitive: true } })])
    h.editor.select(['i'])
    const c = h.editor.styleContext()
    expect(c.applicable).toEqual(['strokeColor', 'strokeWidth', 'opacity'])
    expect(c.values.strokeWidth).toBe(4)
  })

  it('emits style on selection, tool and style changes', () => {
    const h = setup()
    addRaw(h, [shape('a', 0, 0)])
    const seen: string[] = []
    h.editor.on('style', (c) => seen.push(c.source))
    h.editor.select(['a'])
    h.editor.clearSelection()
    h.editor.setTool('arrow')
    h.editor.setStyle({ strokeColor: '#f00' })
    expect(seen).toEqual(['selection', 'tool', 'tool', 'tool'])
    // doc change touching the selection
    h.editor.select(['a'])
    seen.length = 0
    h.doc.apply([{ type: 'updateObjects', pageId: h.pageId, patches: [{ id: 'a', patch: { style: { ...o(h, 'a').style, strokeWidth: 4 } } }] }], 'journal')
    expect(seen).toContain('selection')
  })
})

describe('setStyle', () => {
  it('restyles the selection in one undo step and updates itemStyle', () => {
    const h = setup()
    const ed = h.editor
    addRaw(h, [ink('i', [[0, 0], [5, 5]]), shape('s', 50, 50), arrow('a', 0, 0, 40, 40), text('t', 10, 10)])
    ed.select(['i', 's', 'a', 't'])
    const before = h.ops.length
    const n = ed.setStyle({ strokeColor: '#e03131', opacity: 0.5, strokeWidth: 4, backgroundColor: '#a5d8ff', fontSize: 36, textAlign: 'center' })
    expect(n).toBe(4)
    expect(h.ops.length).toBe(before + 1)
    expect(o(h, 'i').style).toMatchObject({ color: '#e03131', opacity: 0.5, width: 4.5 })
    expect(o(h, 's').style).toMatchObject({ strokeColor: '#e03131', strokeWidth: 4, fillColor: '#a5d8ff' })
    expect(o(h, 'a').style.fillColor).toBeUndefined()
    expect(o(h, 't')).toMatchObject({ color: '#e03131', fontSize: 36, align: 'center', opacity: 0.5 })
    expect(ed.itemStyle).toMatchObject({ strokeColor: '#e03131', backgroundColor: '#a5d8ff', fontSize: 36 })
    expect(ed.toolOptions.shape.fillColor).toBe('#a5d8ff')
    ed.undo()
    expect(o(h, 's').style.strokeColor).toBe('#000')
    expect(o(h, 's').style.fillColor).toBeUndefined()
    expect(o(h, 't').fontSize).toBe(20)
    expect(ed.canUndo).toBe(false)
  })

  it('transparent background removes the fill', () => {
    const h = setup()
    addRaw(h, [shape('s', 0, 0, 50, 50, { style: { strokeColor: '#000', strokeWidth: 2, opacity: 1, roughness: 1, seed: 1, fillColor: '#f00' } })])
    h.editor.select(['s'])
    h.editor.setStyle({ backgroundColor: 'transparent' })
    expect(o(h, 's').style.fillColor).toBeUndefined()
    expect(h.editor.itemStyle.backgroundColor).toBe('transparent')
  })

  it('coalesces slider drags into one undo step', () => {
    const h = setup()
    addRaw(h, [shape('s', 0, 0)])
    h.editor.select(['s'])
    for (const v of [0.9, 0.7, 0.5, 0.3]) h.editor.setStyle({ opacity: v }, { coalesceKey: 'opacity' })
    expect(o(h, 's').style.opacity).toBe(0.3)
    h.editor.undo()
    expect(o(h, 's').style.opacity).toBe(1)
    expect(h.editor.canUndo).toBe(false)
  })

  it('without selection updates itemStyle (shape) or the tool options (pen/highlighter)', () => {
    const h = setup()
    const ed = h.editor
    ed.setTool('shape')
    expect(ed.setStyle({ strokeStyle: 'dashed', fillStyle: 'cross-hatch' })).toBe(0)
    expect(ed.itemStyle).toMatchObject({ strokeStyle: 'dashed', fillStyle: 'cross-hatch' })
    ed.setTool('pen')
    ed.setStyle({ strokeColor: '#1971c2', strokeWidth: 4, opacity: 0.8 })
    expect(ed.toolOptions.pen).toMatchObject({ color: '#1971c2', width: 4.5, opacity: 0.8 })
    expect(ed.itemStyle.strokeColor).toBe('#1e1e1e')
    ed.setTool('highlighter')
    ed.setStyle({ strokeWidth: 1 })
    expect(ed.toolOptions.highlighter.width).toBe(12)
    expect(ed.styleContext().values.strokeWidth).toBe(1)
  })

  it('setItemStyle restores without touching the selection', () => {
    const h = setup()
    addRaw(h, [shape('s', 0, 0)])
    h.editor.select(['s'])
    h.editor.setItemStyle({ strokeColor: '#2f9e44', roughness: 0 })
    expect(o(h, 's').style.strokeColor).toBe('#000')
    expect(h.editor.itemStyle).toMatchObject({ strokeColor: '#2f9e44', roughness: 0 })
  })

  it('arrowType changes clear waypoints; straight to curved keeps none', () => {
    const h = setup()
    addRaw(h, [arrow('a', 0, 0, 100, 100, { arrowType: 'curved', waypoints: [{ x: 50, y: 0 }] })])
    h.editor.select(['a'])
    h.editor.setStyle({ arrowType: 'elbow' })
    expect(o(h, 'a').arrowType).toBe('elbow')
    expect(o(h, 'a').waypoints).toBeUndefined()
    h.editor.setStyle({ arrowType: 'straight' })
    h.editor.setStyle({ arrowType: 'curved', startHead: 'dot', endHead: 'bar' })
    expect(o(h, 'a')).toMatchObject({ arrowType: 'curved', startHead: 'dot', endHead: 'bar' })
    expect(o(h, 'a').waypoints).toBeUndefined()
  })

  it('setSelectionStyle keeps its legacy semantics', () => {
    const h = setup()
    addRaw(h, [ink('i', [[0, 0], [5, 5]])])
    h.editor.select(['i'])
    expect(h.editor.setSelectionStyle({ width: 9 })).toBe(1)
    expect(o(h, 'i').style.width).toBe(9)
  })

  it('new shapes/arrows/text use itemStyle', () => {
    const h = setup()
    const ed = h.editor
    ed.setItemStyle({ strokeColor: '#e03131', backgroundColor: '#ffc9c9', fillStyle: 'solid', strokeStyle: 'dotted', arrowType: 'elbow', endHead: 'triangle' })
    ed.setTool('shape')
    ed.setToolOptions('shape', { kind: 'ellipse' })
    expect(ed.shapeStyle()).toMatchObject({ strokeColor: '#e03131', fillColor: '#ffc9c9', fillStyle: 'solid', strokeStyle: 'dotted' })
    expect(ed.arrowStyle().fillColor).toBeUndefined()
    ed.setToolOptions('text', { fontSize: 28 })
    expect(ed.itemStyle.fontSize).toBe(28)
  })
})

describe('layers', () => {
  it('bringForward / sendBackward move one step', () => {
    const h = setup()
    addRaw(h, [shape('a', 0, 0, 10, 10, { z: 1 }), shape('b', 0, 0, 10, 10, { z: 2 }), shape('c', 0, 0, 10, 10, { z: 3 })])
    const order = () => h.editor.allObjects().map((x) => x.id).join('')
    h.editor.select(['a'])
    h.editor.bringForward()
    expect(order()).toBe('bac')
    h.editor.bringForward()
    expect(order()).toBe('bca')
    h.editor.bringForward()
    expect(order()).toBe('bca')
    h.editor.sendBackward()
    expect(order()).toBe('bac')
    h.editor.select(['c'])
    h.editor.sendBackward()
    expect(order()).toBe('bca')
    h.editor.undo()
    expect(order()).toBe('bac')
  })
})
