import { describe, expect, it } from 'vitest'
import {
  applyTransform, importExcalidraw, inkPoints, isExcalidrawJson,
  type ArrowObject, type CanvasObject, type GroupObject, type ImageObject, type InkStroke, type ShapeObject, type TextObject,
} from '../src'

const el = (over: Record<string, unknown>) => ({
  id: 'e', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, angle: 0,
  strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
  strokeStyle: 'solid', roughness: 1, opacity: 100, seed: 7, groupIds: [], frameId: null,
  roundness: null, isDeleted: false, boundElements: null, ...over,
})
const file = (elements: unknown[], files: Record<string, unknown> = {}) =>
  ({ type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements, appState: {}, files })
const run = (elements: unknown[], files?: Record<string, unknown>) => importExcalidraw(file(elements, files), { now: 5 })
const only = <T extends CanvasObject['type']>(objects: CanvasObject[], type: T) =>
  objects.filter((o): o is Extract<CanvasObject, { type: T }> => o.type === type)

describe('excalidraw import', () => {
  it('maps a rotated rectangle to a centre-preserving transform', () => {
    const { objects } = run([el({ x: 10, y: 20, angle: Math.PI / 2, roundness: { type: 3 }, backgroundColor: '#ffc9c9', fillStyle: 'zigzag', opacity: 50 })])
    const s = objects[0] as ShapeObject
    expect(s).toMatchObject({ type: 'shape', kind: 'rectangle', width: 100, height: 50, z: 1, createdAt: 5 })
    expect(s.style).toMatchObject({ roundness: 'round', fillColor: '#ffc9c9', fillStyle: 'hachure', opacity: 0.5, seed: 7 })
    const centre = applyTransform(s.transform, { x: 50, y: 25 })
    expect(centre.x).toBeCloseTo(60)
    expect(centre.y).toBeCloseTo(45)
    expect(s.transform.rotation).toBeCloseTo(Math.PI / 2)
  })

  it('keeps arrow bindings between shapes and maps arrowheads', () => {
    const { objects } = run([
      el({ id: 'a' }),
      el({
        id: 'arr', type: 'arrow', x: 100, y: 25, points: [[0, 0], [100, 0]],
        startBinding: { elementId: 'a', fixedPoint: [1, 0.5] }, endBinding: { elementId: 'b', fixedPoint: [0, 0.5] },
        startArrowhead: 'circle_outline', endArrowhead: 'triangle',
      }),
      el({ id: 'b', x: 200 }),
    ])
    const [a, arrow, b] = objects as [ShapeObject, ArrowObject, ShapeObject]
    expect(arrow).toMatchObject({
      type: 'arrow', start: { x: 100, y: 25 }, end: { x: 200, y: 25 }, startHead: 'dot', endHead: 'triangle',
      startBinding: { objectId: a.id }, endBinding: { objectId: b.id },
    })
    expect(arrow.arrowType).toBeUndefined()
    expect([a.id, b.id]).not.toContain('a')
  })

  it('turns container text into a label with labelSize', () => {
    const { objects } = run([
      el({ id: 'box' }),
      el({ id: 't', type: 'text', text: 'wrapped\nline', originalText: 'wrapped line', fontSize: 28, fontFamily: 5, containerId: 'box' }),
    ])
    expect(objects).toHaveLength(1)
    expect(objects[0]).toMatchObject({ type: 'shape', label: 'wrapped line', labelSize: 28 })
  })

  it('maps free text with font, alignment and fixed width', () => {
    const { objects } = run([el({ type: 'text', x: 5, y: 6, text: 'hi', fontSize: 16, fontFamily: 3, textAlign: 'center', autoResize: false, width: 120, strokeColor: '#e03131' })])
    expect(objects[0] as TextObject).toMatchObject({
      type: 'text', text: 'hi', fontSize: 16, fontFamily: 'mono', align: 'center', width: 120, color: '#e03131',
      transform: { x: 5, y: 6, rotation: 0 },
    })
  })

  it('turns freedraw into ink with pressures', () => {
    const { objects } = run([el({ type: 'freedraw', x: 3, y: 4, strokeWidth: 2, points: [[0, 0], [5, 2], [9, 1]], pressures: [0.2, 0.6, 0.9], simulatePressure: false })])
    const ink = objects[0] as InkStroke
    expect(ink).toMatchObject({ type: 'ink', transform: { x: 3, y: 4 }, startedAt: 5, pointerType: 'pen' })
    expect(ink.style).toMatchObject({ tool: 'pen', width: 2.5, pressureSensitive: true })
    expect(inkPoints(ink).map((p) => [p.x, p.y, p.pressure, p.t])).toEqual([[0, 0, 0.2, 0], [5, 2, 0.6, 8], [9, 1, 0.9, 16]])
  })

  it('turns a 3-point line into a line shape fitted to its point bbox', () => {
    const { objects } = run([el({ type: 'line', x: 100, y: 100, points: [[0, 0], [-20, 30], [40, 10]] })])
    expect(objects[0] as ShapeObject).toMatchObject({
      type: 'shape', kind: 'line', width: 60, height: 30, transform: { x: 80, y: 100 },
      points: [{ x: 20, y: 0 }, { x: 0, y: 30 }, { x: 60, y: 10 }],
    })
  })

  it('creates nested groups with remapped ids', () => {
    const { objects } = run([
      el({ id: 'r1', groupIds: ['inner', 'outer'] }),
      el({ id: 'r2', groupIds: ['inner', 'outer'] }),
      el({ id: 'r3', groupIds: ['outer'] }),
    ])
    const [r1, r2, r3] = objects
    const groups = only(objects, 'group')
    expect(groups).toHaveLength(2)
    const inner = groups.find((g) => g.childIds.includes(r1.id)) as GroupObject
    const outer = groups.find((g) => g !== inner) as GroupObject
    expect(inner.childIds).toEqual([r1.id, r2.id])
    expect(outer.childIds).toEqual([inner.id, r3.id])
    expect([r1.groupId, r2.groupId, r3.groupId, inner.groupId]).toEqual([inner.id, inner.id, outer.id, outer.id])
    expect([inner.z, outer.z]).toEqual([2, 3])
  })

  it('imports frames and sets frameId on their children', () => {
    const { objects } = run([el({ id: 'f', type: 'frame', name: 'Intro', width: 400, height: 300 }), el({ id: 'r', frameId: 'f' })])
    const [frame, rect] = objects as [ShapeObject, ShapeObject]
    expect(frame).toMatchObject({ kind: 'frame', label: 'Intro' })
    expect(rect.frameId).toBe(frame.id)
  })

  it('imports images with their file as an asset and skips images without one', () => {
    const { objects, assets, bounds } = run(
      [el({ type: 'image', fileId: 'f1', x: 10, y: 10 }), el({ type: 'image', fileId: 'missing' })],
      { f1: { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 1 } },
    )
    expect(objects).toHaveLength(1)
    const img = objects[0] as ImageObject
    expect(assets).toEqual([{ id: img.assetId, mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }])
    expect(img).toMatchObject({ mimeType: 'image/png', width: 100, height: 50 })
    expect(bounds).toEqual({ x: 10, y: 10, width: 100, height: 50 })
  })

  it('accepts clipboard payloads, skips deleted and unknown elements, rejects garbage', () => {
    const { objects } = importExcalidraw({
      type: 'excalidraw/clipboard',
      elements: [el({ isDeleted: true }), el({ type: 'embeddable' }), el({ type: 'ellipse' })],
      files: {},
    })
    expect(objects.map((o) => o.type === 'shape' && o.kind)).toEqual(['ellipse'])
    expect(() => importExcalidraw({ type: 'tldraw', elements: [] })).toThrow(/not an Excalidraw/)
    expect(() => importExcalidraw('nope')).toThrow()
  })

  it('detects Excalidraw JSON text', () => {
    expect(isExcalidrawJson('{"type":"excalidraw/clipboard","elements":[]}')).toBe(true)
    expect(isExcalidrawJson('{\n  "type": "excalidraw",\n  "version": 2')).toBe(true)
    expect(isExcalidrawJson('{"type":"folio"}')).toBe(false)
    expect(isExcalidrawJson('hello excalidraw')).toBe(false)
  })
})
