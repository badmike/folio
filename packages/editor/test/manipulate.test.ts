import type { InkStroke, ShapeObject, TextObject } from '@folio/document'
import { describe, expect, it } from 'vitest'
import {
  cloneObjects, computeFrame, computeMovePatches, computeRotatePatches, computeScalePatches, scaleFromHandle,
} from '../src'
import { arrow, ink, shape, text } from './helpers'

const R = (map: Record<string, unknown>) => (id: string) => map[id] as never
type P = { transform: { x: number; y: number; rotation: number; scaleX: number; scaleY: number } }

describe('manipulation patches', () => {
  it('move rewrites transforms only; arrows shift and drop bindings to unselected targets', () => {
    const s = ink('i', [[0, 0], [10, 10]], 5, 5)
    const a = arrow('a', 0, 0, 50, 50, { startBinding: { objectId: 'x' } })
    const res = R({ i: s, a })
    const patches = computeMovePatches([s, a], 10, -5, res)
    expect((patches[0].patch as P).transform).toMatchObject({ x: 15, y: 0 })
    expect(patches[0].patch).not.toHaveProperty('points')
    expect(patches[1].patch).toMatchObject({ start: { x: 10, y: -5 }, end: { x: 60, y: 45 }, $unset: ['startBinding'] })
  })

  it('rotate about a center', () => {
    const sh = shape('s', 100, 0)
    const [p] = computeRotatePatches([sh], { x: 0, y: 0 }, Math.PI / 2, R({ s: sh }))
    const t = (p.patch as P).transform
    expect(t.x).toBeCloseTo(0)
    expect(t.y).toBeCloseTo(100)
    expect(t.rotation).toBeCloseTo(Math.PI / 2)
  })

  it('scale: ink via transform, shape via width/height, text via fontSize', () => {
    const i = ink('i', [[0, 0], [100, 50]], 10, 10)
    const sh = shape('s', 10, 10, 100, 50)
    const tx = text('t', 10, 10, 'abc', { fontSize: 20 })
    const frame = computeFrame([i], R({}))!
    expect(frame.rect.width).toBeGreaterThan(0)
    // anchor at top-left of the union, scale 2x both
    const spec = { anchor: { x: 10, y: 10 }, theta: 0, sx: 2, sy: 2 }
    const res = R({ i, s: sh, t: tx })
    const [pi, ps, pt] = computeScalePatches([i, sh, tx], spec, res)
    expect((pi.patch as P).transform).toMatchObject({ x: 10, y: 10, scaleX: 2, scaleY: 2 })
    expect(ps.patch).toMatchObject({ width: 200, height: 100 })
    expect(pt.patch).toMatchObject({ fontSize: 40 })
    // objects away from the anchor move proportionally
    const far = shape('f', 60, 60)
    const [pf] = computeScalePatches([far], spec, R({ f: far }))
    expect((pf.patch as P).transform).toMatchObject({ x: 110, y: 110 })
  })

  it('scaleFromHandle: se handle drag doubles size about nw anchor, shift keeps aspect', () => {
    const sh = shape('s', 0, 0, 100, 50)
    const frame = computeFrame([sh], R({}))!
    const spec = scaleFromHandle(frame, 'se', { x: 200, y: 50 }, false)
    expect(spec.sx).toBeCloseTo(2)
    expect(spec.sy).toBeCloseTo(1)
    expect(spec.anchor).toEqual({ x: 0, y: 0 })
    const keep = scaleFromHandle(frame, 'se', { x: 200, y: 60 }, true)
    expect(keep.sx).toBeCloseTo(keep.sy)
    const edge = scaleFromHandle(frame, 'e', { x: 300, y: 999 }, false)
    expect(edge.sx).toBeCloseTo(3)
    expect(edge.sy).toBe(1)
    const tiny = scaleFromHandle(frame, 'e', { x: -500, y: 0 }, false)
    expect(tiny.sx).toBeGreaterThan(0)
  })

  it('single rotated object scales in its own axes', () => {
    const sh = shape('s', 0, 0, 100, 50, { transform: { x: 0, y: 0, rotation: Math.PI / 2, scaleX: 1, scaleY: 1 } })
    const frame = computeFrame([sh], R({}))!
    expect(frame.rotation).toBeCloseTo(Math.PI / 2)
    // frame's east handle in frame axes → object width
    const spec = scaleFromHandle(frame, 'e', { x: frame.center.x, y: frame.center.y + 50 + 50 }, false)
    // half-width is 50 → pointer 100 away along +y (object's +x) → sx = (100+50)/100
    expect(spec.sx).toBeCloseTo(1.5)
    const [p] = computeScalePatches([sh], spec, R({ s: sh }))
    expect((p.patch as Partial<ShapeObject>).width).toBeCloseTo(150)
    expect((p.patch as Partial<ShapeObject>).height).toBeCloseTo(50)
  })

  it('cloneObjects remaps groups and internal bindings, drops external ones', () => {
    const a = shape('a', 0, 0, 100, 60, { groupId: 'g' })
    const b = shape('b', 200, 0, 100, 60, { groupId: 'g' })
    const g = { id: 'g', type: 'group' as const, childIds: ['a', 'b'], transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, z: 3, createdAt: 0, updatedAt: 0 }
    const internal = arrow('ar', 100, 30, 200, 30, { startBinding: { objectId: 'a' }, endBinding: { objectId: 'b' } })
    const external = arrow('ex', 0, 0, 10, 10, { startBinding: { objectId: 'outside' }, endBinding: { objectId: 'a' } })
    const { objects, idMap } = cloneObjects([a, b, g, internal, external], 20, 20, 10)
    const byOld = (id: string) => objects.find((o) => o.id === idMap.get(id))!
    expect(new Set(objects.map((o) => o.id)).size).toBe(5)
    for (const o of objects) expect(['a', 'b', 'g', 'ar', 'ex']).not.toContain(o.id)
    expect((byOld('a') as ShapeObject).transform).toMatchObject({ x: 20, y: 20 })
    expect(byOld('a').groupId).toBe(idMap.get('g'))
    expect(byOld('g')).toMatchObject({ childIds: [idMap.get('a'), idMap.get('b')] })
    expect(byOld('ar')).toMatchObject({
      start: { x: 120, y: 50 }, startBinding: { objectId: idMap.get('a') }, endBinding: { objectId: idMap.get('b') },
    })
    const ex = byOld('ex') as { startBinding?: unknown; endBinding?: { objectId: string } }
    expect(ex.startBinding).toBeUndefined()
    expect(ex.endBinding?.objectId).toBe(idMap.get('a'))
    expect(objects.every((o) => o.z > 10)).toBe(true)
    void ({} as InkStroke | TextObject)
  })
})
