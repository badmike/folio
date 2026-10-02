import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageObject, ShapeObject, TextObject } from '@folio/document'
import { noteTailPoint } from '@folio/renderer'
import { addRaw, drag, objs, pointer, setup, shape, text } from './helpers'
import type { Harness } from './helpers'

let h: Harness
afterEach(() => h?.editor.destroy())

const counters = () => objs(h).filter((o): o is ShapeObject => o.type === 'shape' && o.kind === 'counter')
const tap = (x: number, y: number) => { pointer(h, 'pointerdown', x, y); pointer(h, 'pointerup', x, y) }
const typeAndCommit = (value: string) => {
  h.editor.domLayer.querySelector('textarea')!.value = value
  h.editor.commitTextEdit()
}

describe('counters', () => {
  it('taps place the next number and the tool stays active; numbers continue after the highest', () => {
    h = setup()
    h.editor.setTool('counter')
    tap(100, 100)
    tap(200, 100)
    expect(counters().map((c) => c.label)).toEqual(['1', '2'])
    expect(h.editor.tool).toBe('counter')
    h.editor.deleteObjects([counters()[0].id])
    tap(300, 100)
    expect(counters().map((c) => c.label).sort()).toEqual(['2', '3'])
  })

  it('new counters use the counter colours, and a drag aims the pin', () => {
    h = setup()
    h.editor.setTool('counter')
    drag(h, [100, 100], [100, 200])
    const c = counters()[0]
    expect(c.style.fillColor).toBe('#e03131')
    expect(c.style.strokeColor).toBe('#ffffff')
    // the pin points straight down from its centre
    expect(c.tail!.x).toBeCloseTo(c.width / 2)
    expect(c.tail!.y).toBeGreaterThan(c.height)
    // the next tool without colours of its own goes back to the shared colours, not the counter's
    h.editor.setTool('arrow')
    expect(h.editor.itemStyle.strokeColor).toBe('#1e1e1e')
  })
})

describe('notes', () => {
  it('a drag writes a note that points at where the drag started', () => {
    h = setup()
    h.editor.setTool('note')
    drag(h, [100, 100], [300, 300])
    typeAndCommit('Look here')
    const n = objs(h).find((o): o is TextObject => o.type === 'text')!
    expect(n.text).toBe('Look here')
    expect(n.background).toBe('#e03131')
    expect(n.transform.x + n.tail!.x).toBeCloseTo(100)
    expect(n.transform.y + n.tail!.y).toBeCloseTo(100)
    expect(h.editor.tool).toBe('select')
  })

  it('dragging the handle below a selected note adds a pointer; a transparent background makes it plain text', () => {
    h = setup()
    addRaw(h, [text('n', 100, 100, 'Note', { background: '#e03131', color: '#ffffff' })])
    h.editor.setTool('select')
    h.editor.select(['n'])
    const handle = h.editor.selectedTailHandle()!
    expect(handle.virtual).toBe(true)
    drag(h, [handle.world.x, handle.world.y], [400, 400])
    const n = h.doc.object(h.pageId, 'n') as TextObject
    expect(n.tail).toEqual({ x: 300, y: 300 })
    // while its text is edited, the text shows in the note's colour (the canvas copy is hidden)
    h.editor.startTextEdit('n')
    expect(h.editor.domLayer.querySelector('textarea')!.style.color).toBe('#ffffff')
    h.editor.commitTextEdit()
    h.editor.setStyle({ backgroundColor: 'transparent' })
    const plain = h.doc.object(h.pageId, 'n') as TextObject
    expect(plain.background).toBeUndefined()
    expect(plain.tail).toBeUndefined()
  })
})

describe('note pointers', () => {
  it('stick to the object they are dropped on, follow it and stay put when it is deleted', () => {
    h = setup()
    addRaw(h, [shape('s', 400, 400, 100, 60, { style: { strokeColor: '#000', fillColor: '#eee', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1 } })])
    addRaw(h, [text('n', 100, 100, 'Note', { background: '#e03131', color: '#ffffff' })])
    h.editor.setTool('select')
    h.editor.select(['n'])
    const handle = h.editor.selectedTailHandle()!
    // dropped near the shape's centre: snaps to it
    drag(h, [handle.world.x, handle.world.y], [452, 428])
    const bound = h.doc.object(h.pageId, 'n') as TextObject
    expect(bound.tailBinding).toEqual({ objectId: 's', anchor: { x: 0.5, y: 0.5 } })
    h.editor.select(['s'])
    h.editor.nudgeSelection(50, 0)
    const tip = () => noteTailPoint(h.doc.object(h.pageId, 'n') as TextObject, h.editor.resolve)!
    expect(tip().x + 100).toBeCloseTo(500)
    h.editor.deleteObjects(['s'])
    const freed = h.doc.object(h.pageId, 'n') as TextObject
    expect(freed.tailBinding).toBeUndefined()
    expect(tip().x + 100).toBeCloseTo(500)
  })
})

describe('images', () => {
  it('inserts an image at the view centre, at most 60% of the view, and resizing keeps its aspect ratio', () => {
    h = setup()
    const id = h.editor.insertImage({ assetId: 'a1', mimeType: 'image/png', width: 2000, height: 1000 })!
    const img = h.doc.object(h.pageId, id) as ImageObject
    expect(img.width).toBeCloseTo(600)
    expect(img.height).toBeCloseTo(300)
    expect(img.transform.x + img.width / 2).toBeCloseTo(500)
    expect(img.transform.y + img.height / 2).toBeCloseTo(400)
    // drag the east handle: width and height scale together
    drag(h, [800, 400], [1100, 400])
    const t = (h.doc.object(h.pageId, id) as ImageObject).transform
    expect(t.scaleX).toBeCloseTo(1.5)
    expect(t.scaleY).toBeCloseTo(1.5)
  })

  it('hands dropped files to the host with the drop point in world space', () => {
    const onInsertFiles = vi.fn()
    h = setup({ onInsertFiles })
    h.editor.setCamera({ x: 100, y: 50, zoom: 2 })
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const ev = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], types: ['Files'] } })
    Object.defineProperty(ev, 'clientX', { value: 200 })
    Object.defineProperty(ev, 'clientY', { value: 100 })
    h.editor.root.dispatchEvent(ev)
    expect(onInsertFiles).toHaveBeenCalledWith([file], { x: 200, y: 100 })
  })
})
