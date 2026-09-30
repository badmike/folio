import { afterEach, describe, expect, it } from 'vitest'
import type { InkStroke, ShapeObject } from '@folio/document'
import { addRaw, drag, key, objs, pointer, setup, shape } from './helpers'
import type { Harness } from './helpers'

let h: Harness
afterEach(() => h?.editor.destroy())

const obj = (id: string) => h.doc.object(h.pageId, id) as ShapeObject

describe('tool lock and tool switching', () => {
  it('one-shot tools return to select unless locked; Q toggles the lock', () => {
    h = setup()
    h.editor.setTool('shape')
    drag(h, [100, 100], [200, 160])
    expect(h.editor.tool).toBe('select')
    expect(h.editor.selection).toHaveLength(1)
    key('q')
    expect(h.editor.toolLock).toBe(true)
    h.editor.setTool('arrow')
    drag(h, [300, 300], [400, 300])
    expect(h.editor.tool).toBe('arrow')
  })

  it('switching to any other tool, hand included, drops the selection', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0)])
    h.editor.setTool('select')
    h.editor.select(['a'])
    h.editor.setTool('hand')
    expect(h.editor.selection).toEqual([])
    h.editor.select(['a'])
    h.editor.setTool('pen')
    expect(h.editor.selection).toEqual([])
  })

  it('hand tool pans with the mouse and never draws', () => {
    h = setup()
    h.editor.setTool('hand')
    const cam = { ...h.editor.camera }
    drag(h, [100, 100], [160, 140])
    expect(objs(h)).toHaveLength(0)
    expect(h.editor.camera.x).toBeCloseTo(cam.x - 60)
    expect(h.editor.camera.y).toBeCloseTo(cam.y - 40)
  })

  it('Excalidraw letters and digits pick tools and shape kinds', () => {
    h = setup()
    h.editor.setTool('select')
    drag(h, [5, 5], [5, 5]) // marks the editor active
    key('d')
    expect(h.editor.tool).toBe('shape')
    expect(h.editor.toolOptions.shape.kind).toBe('diamond')
    key('6')
    expect(h.editor.toolOptions.shape.kind).toBe('line')
    key('h')
    expect(h.editor.tool).toBe('hand')
    key('f')
    expect(h.editor.tool).toBe('frame')
    key('x')
    expect(h.editor.tool).toBe('blur')
    key('m')
    expect(h.editor.tool).toBe('highlighter')
    key('1')
    expect(h.editor.tool).toBe('select')
  })

  it('Cmd+[ / Cmd+] step the z-order; Cmd+Shift+arrows align', () => {
    h = setup()
    addRaw(h, [{ ...shape('a', 0, 0), z: 1 }, { ...shape('b', 200, 50), z: 2 }])
    h.editor.setTool('select')
    drag(h, [5, 5], [5, 5])
    h.editor.select(['a'])
    key(']', { meta: true })
    expect(obj('a').z).toBeGreaterThan(obj('b').z)
    h.editor.select(['a', 'b'])
    key('ArrowUp', { meta: true, shift: true })
    expect(obj('b').transform.y).toBe(0)
  })
})

describe('align and distribute', () => {
  it('aligns selection units to edges and centres', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0, 100, 60), shape('b', 200, 100, 50, 50), shape('c', 400, 200, 100, 100)])
    h.editor.select(['a', 'b', 'c'])
    h.editor.alignSelection('left')
    expect([obj('a').transform.x, obj('b').transform.x, obj('c').transform.x]).toEqual([0, 0, 0])
    h.editor.alignSelection('bottom')
    expect(obj('a').transform.y + 60).toBe(300)
    expect(obj('b').transform.y + 50).toBe(300)
    h.editor.alignSelection('centerX')
    expect(obj('b').transform.x + 25).toBe(50)
    // one undo step per alignment
    h.editor.undo()
    expect(obj('b').transform.x).toBe(0)
  })

  it('distributes three or more units with equal gaps', () => {
    h = setup()
    addRaw(h, [shape('a', 0, 0, 100, 10), shape('b', 120, 0, 100, 10), shape('c', 500, 0, 100, 10)])
    h.editor.select(['a', 'b', 'c'])
    h.editor.distributeSelection('horizontal')
    expect(obj('b').transform.x).toBe(250)
    h.editor.select(['a', 'b'])
    h.editor.distributeSelection('horizontal')
    expect(obj('b').transform.x).toBe(250) // needs three units
  })
})

describe('frames', () => {
  it('a new frame adopts what it encloses and moves with its content', () => {
    h = setup({ toolLock: true })
    addRaw(h, [shape('in', 120, 120, 50, 50), shape('out', 600, 600, 50, 50)])
    h.editor.setTool('frame')
    drag(h, [100, 100], [300, 300])
    const frame = objs(h).find((o) => o.type === 'shape' && o.kind === 'frame') as ShapeObject
    expect(frame.label).toBe('Frame 1')
    expect(obj('in').frameId).toBe(frame.id)
    expect(obj('in').z).toBeGreaterThan(frame.z)
    expect(obj('out').frameId).toBeUndefined()
    h.editor.setTool('select')
    h.editor.select([frame.id])
    h.editor.nudgeSelection(10, 0)
    expect(obj('in').transform.x).toBe(130)
    expect(obj('out').transform.x).toBe(600)
  })

  it('dragging an object out of a frame leaves it; deleting a frame deletes its content', () => {
    h = setup()
    addRaw(h, [
      { ...shape('f', 0, 0, 300, 300), kind: 'frame' as const, z: 1 },
      { ...shape('a', 50, 50, 50, 50), z: 2, frameId: 'f' },
    ])
    h.editor.setTool('select')
    h.editor.select(['a'])
    h.editor.commitTransform([{ id: 'a', patch: { transform: { x: 500, y: 500, rotation: 0, scaleX: 1, scaleY: 1 } } }])
    expect(obj('a').frameId).toBeUndefined()
    h.editor.commitTransform([{ id: 'a', patch: { transform: { x: 60, y: 60, rotation: 0, scaleX: 1, scaleY: 1 } } }])
    expect(obj('a').frameId).toBe('f')
    h.editor.select(['f'])
    h.editor.deleteSelection()
    expect(objs(h)).toHaveLength(0)
  })

  it('ink drawn inside a frame joins it', async () => {
    h = setup()
    addRaw(h, [{ ...shape('f', 0, 0, 400, 400), kind: 'frame' as const }])
    h.editor.setTool('pen')
    drag(h, [100, 100], [150, 150])
    h.editor.flushPending()
    const ink = objs(h).find((o) => o.type === 'ink') as InkStroke
    expect(ink.frameId).toBe('f')
  })
})

describe('lines with points', () => {
  it('dragging a segment middle inserts a point; dragging an end keeps the polyline', () => {
    h = setup()
    addRaw(h, [{ ...shape('l', 100, 100, 200, 0), kind: 'line' as const }])
    h.editor.setTool('select')
    h.editor.select(['l'])
    drag(h, [200, 100], [200, 160]) // v:0 handle at the middle
    let l = obj('l')
    expect(l.points).toHaveLength(3)
    expect(l.points![1]).toEqual({ x: 100, y: 60 })
    expect(l.height).toBe(60)
    expect(l.transform).toMatchObject({ x: 100, y: 100, scaleX: 1, scaleY: 1 })
    drag(h, [300, 100], [340, 100]) // end handle
    l = obj('l')
    expect(l.points![2]).toEqual({ x: 240, y: 0 })
    expect(l.width).toBe(240)
    h.editor.undo()
    h.editor.undo()
    expect(obj('l').points).toBeUndefined()
  })

  it('a double tap on an interior point removes it', () => {
    h = setup()
    addRaw(h, [{ ...shape('l', 100, 100, 200, 60), kind: 'line' as const, points: [{ x: 0, y: 0 }, { x: 100, y: 60 }, { x: 200, y: 0 }] }])
    h.editor.setTool('select')
    h.editor.select(['l'])
    pointer(h, 'pointerdown', 200, 160)
    pointer(h, 'pointerup', 200, 160)
    pointer(h, 'pointerdown', 200, 160)
    pointer(h, 'pointerup', 200, 160)
    const l = obj('l')
    expect(l.points).toBeUndefined()
    expect(l.height).toBe(0)
  })

  it('scaling a subdivided line scales its points', () => {
    h = setup()
    addRaw(h, [{ ...shape('l', 0, 0, 200, 100), kind: 'line' as const, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }] }])
    h.editor.select(['l'])
    h.editor.commitTransform([{ id: 'l', patch: { width: 400, height: 100, points: [{ x: 0, y: 0 }, { x: 200, y: 100 }, { x: 400, y: 0 }] } }])
    expect(obj('l').points![1]).toEqual({ x: 200, y: 100 })
  })
})

describe('elbow arrows', () => {
  it('dragging the first segment of a straight elbow route subdivides it', () => {
    h = setup()
    addRaw(h, [{
      id: 'e', type: 'arrow', transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, z: 1, createdAt: 1, updatedAt: 1,
      start: { x: 100, y: 100 }, end: { x: 400, y: 100 }, arrowType: 'elbow', startHead: 'none', endHead: 'arrow',
      style: { strokeColor: '#000', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1 },
    }])
    h.editor.setTool('select')
    h.editor.select(['e'])
    const handles = h.editor.selectedPathHandles()!
    expect(handles.filter((x) => x.kind === 'virtual')).toHaveLength(1)
    drag(h, [250, 100], [250, 200])
    const a = h.doc.object(h.pageId, 'e') as { waypoints?: { x: number; y: number }[] }
    expect(a.waypoints).toEqual([{ x: 100, y: 200 }, { x: 400, y: 200 }])
  })
})

describe('flick, stylus eraser, tool colours, frame extraction', () => {
  it('a fast one-finger pan keeps coasting after the finger lifts', async () => {
    h = setup()
    h.editor.setTool('hand')
    const x0 = h.editor.camera.x
    const t0 = performance.now()
    const at = (t: number) => Object.defineProperty(new Event('x'), 'timeStamp', { value: t })
    void at
    pointer(h, 'pointerdown', 400, 300)
    for (let i = 1; i <= 5; i++) pointer(h, 'pointermove', 400 - i * 30, 300)
    pointer(h, 'pointerup', 250, 300)
    const afterUp = h.editor.camera.x
    expect(afterUp).toBeCloseTo(x0 + 150)
    await new Promise((r) => setTimeout(r, 120))
    expect(h.editor.camera.x).toBeGreaterThan(afterUp + 5)
    expect(performance.now() - t0).toBeGreaterThan(0)
    h.editor.input.flick.stop()
  })

  it('the eraser end of a stylus erases even with the pen tool active', () => {
    h = setup()
    addRaw(h, [shape('a', 100, 100)])
    h.editor.setTool('pen')
    pointer(h, 'pointerdown', 80, 120, { pointerType: 'pen', button: 5 })
    pointer(h, 'pointermove', 140, 130, { pointerType: 'pen', button: 5 }) // crosses the left edge
    pointer(h, 'pointerup', 140, 130, { pointerType: 'pen', button: 5 })
    h.editor.flushPending()
    expect(objs(h)).toHaveLength(0)
  })

  it('each drawing tool remembers its own colours', () => {
    h = setup()
    h.editor.setTool('shape')
    h.editor.setStyle({ strokeColor: '#e03131', backgroundColor: '#ffc9c9' })
    h.editor.setTool('arrow')
    expect(h.editor.itemStyle.strokeColor).toBe('#e03131') // shared until the arrow gets its own colour
    h.editor.setStyle({ strokeColor: '#1971c2' })
    h.editor.setTool('shape')
    expect(h.editor.itemStyle.strokeColor).toBe('#e03131')
    expect(h.editor.itemStyle.backgroundColor).toBe('#ffc9c9')
    h.editor.setTool('arrow')
    expect(h.editor.itemStyle.strokeColor).toBe('#1971c2')
    expect(h.editor.toolColors.arrow?.strokeColor).toBe('#1971c2')
    // restyling a selected shape becomes the shape tool's colour (Excalidraw default semantics)
    addRaw(h, [shape('s', 0, 0)])
    h.editor.setTool('select')
    h.editor.select(['s'])
    h.editor.setStyle({ strokeColor: '#2f9e44' })
    h.editor.setTool('shape')
    expect(h.editor.itemStyle.strokeColor).toBe('#2f9e44')
  })

  it('a frame can be removed while keeping its content, and its content selected', () => {
    h = setup()
    addRaw(h, [
      { ...shape('f', 0, 0, 300, 300), kind: 'frame' as const, z: 1 },
      { ...shape('a', 50, 50, 50, 50), z: 2, frameId: 'f' },
      { ...shape('b', 150, 50, 50, 50), z: 3, frameId: 'f' },
    ])
    h.editor.select(['f'])
    h.editor.selectFrameContent()
    expect([...h.editor.selection].sort()).toEqual(['a', 'b'])
    h.editor.select(['f'])
    h.editor.unframeSelection()
    expect(objs(h).map((o) => o.id).sort()).toEqual(['a', 'b'])
    expect(obj('a').frameId).toBeUndefined()
    h.editor.undo()
    expect(obj('a').frameId).toBe('f')
  })
})
