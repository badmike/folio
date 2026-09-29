import { describe, expect, it } from 'vitest'
import {
  PAGE_FORMATS, applyTransform, boundsUnion, createPage, defaultToolSettings, distanceToSegment, encodeInkPoints,
  identityTransform, inkPoints, invertTransform, localBounds, rectContains, rectIntersects, resolveArrowEndpoints,
  transformsCompose, worldBounds, createId,
} from '../src'
import { arrow, shape, stroke } from './helpers'

describe('geometry', () => {
  it('transform round trip', () => {
    const t = { x: 10, y: -5, rotation: 0.7, scaleX: 2, scaleY: 0.5 }
    const p = { x: 3, y: 4 }
    const q = invertTransform(t, applyTransform(t, p))
    expect(q.x).toBeCloseTo(3); expect(q.y).toBeCloseTo(4)
    expect(applyTransform(identityTransform(), p)).toEqual(p)
    const c = transformsCompose({ x: 1, y: 2, rotation: 0.3, scaleX: 2, scaleY: 2 }, { x: 5, y: 0, rotation: 0.2, scaleX: 1, scaleY: 1 })
    const direct = applyTransform({ x: 1, y: 2, rotation: 0.3, scaleX: 2, scaleY: 2 }, applyTransform({ x: 5, y: 0, rotation: 0.2, scaleX: 1, scaleY: 1 }, p))
    const comp = applyTransform(c, p)
    expect(comp.x).toBeCloseTo(direct.x); expect(comp.y).toBeCloseTo(direct.y)
  })

  it('ink point encoding round-trips and bounds include stroke width', () => {
    const s = stroke(10, 20, 4, { style: { tool: 'pen', color: '#000', width: 4, opacity: 1, pressureSensitive: false } })
    expect(encodeInkPoints(inkPoints(s))).toEqual(s.points)
    const b = localBounds(s)
    expect(b.x).toBe(8); expect(b.width).toBe(9 + 4)
  })

  it('world bounds of rotated/scaled shapes', () => {
    const sh = shape(0, 0, 100, 50, { transform: { x: 10, y: 10, rotation: Math.PI / 2, scaleX: 1, scaleY: 1 } })
    const b = worldBounds(sh)
    expect(b.x).toBeCloseTo(-40); expect(b.y).toBeCloseTo(10); expect(b.width).toBeCloseTo(50); expect(b.height).toBeCloseTo(100)
  })

  it('bound arrow endpoints sit on target edges', () => {
    const a = shape(0, 0, 100, 100), b = shape(300, 0, 100, 100)
    const ar = arrow({ startBinding: { objectId: a.id }, endBinding: { objectId: b.id } })
    const map = new Map([[a.id, a], [b.id, b]])
    const { start, end } = resolveArrowEndpoints(ar, (id) => map.get(id))
    expect(start.x).toBeCloseTo(100); expect(start.y).toBeCloseTo(50)
    expect(end.x).toBeCloseTo(300); expect(end.y).toBeCloseTo(50)
    const wb = worldBounds(ar, (id) => map.get(id))
    expect(wb.x).toBeCloseTo(100); expect(wb.width).toBeCloseTo(200)
    // diagonal + anchor
    const c = shape(300, 300, 100, 100)
    map.set(c.id, c)
    const diag = resolveArrowEndpoints(arrow({ startBinding: { objectId: a.id }, endBinding: { objectId: c.id } }), (id) => map.get(id))
    expect(diag.start.x).toBeCloseTo(100); expect(diag.start.y).toBeCloseTo(100)
    // missing target falls back to raw point
    expect(resolveArrowEndpoints(arrow({ start: { x: 1, y: 2 }, startBinding: { objectId: 'zz' } }), () => undefined).start).toEqual({ x: 1, y: 2 })
  })

  it('rect and segment helpers', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    expect(rectIntersects(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true)
    expect(rectIntersects(a, { x: 11, y: 0, width: 1, height: 1 })).toBe(false)
    expect(rectContains(a, { x: 1, y: 1, width: 2, height: 2 })).toBe(true)
    expect(rectContains(a, { x: 11, y: 1 })).toBe(false)
    expect(boundsUnion([a, { x: 20, y: 20, width: 5, height: 5 }])).toEqual({ x: 0, y: 0, width: 25, height: 25 })
    expect(distanceToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5)
    expect(distanceToSegment({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5)
  })

  it('factories', () => {
    expect(createId()).not.toBe(createId())
    const p = createPage({ kind: 'fixed', format: 'iPad' })
    expect(p).toMatchObject(PAGE_FORMATS.iPad)
    expect(createPage({ kind: 'fixed' })).toMatchObject(PAGE_FORMATS.A4)
    expect(createPage({ kind: 'infinite' }).width).toBeUndefined()
    const t = defaultToolSettings()
    expect(t.pen).toMatchObject({ color: '#1e1e1e', width: 2.5 })
    expect(t.highlighter).toMatchObject({ color: '#ffd43b', width: 18, opacity: 0.35 })
  })
})
