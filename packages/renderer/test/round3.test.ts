import { describe, expect, it } from 'vitest'
import type { InkStroke, ShapeObject } from '@folio/document'
import { lineHandleSpecs, linePointsAfterDrag, elbowWaypointsAfterDrag } from '../src/arrows'
import { highlighterOutline } from '../src/geometry/ink'
import { buildShapeGeometry } from '../src/geometry/rough'
import { hitTestObject } from '../src/hit'
import { cornerRadius, roundedPolygon, roundedShape, shapeOutline } from '../src/shapes'

const ident = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
const style = { strokeColor: '#000', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1 }
const box = (kind: ShapeObject['kind'], w: number, h: number, extra: Partial<ShapeObject> = {}): ShapeObject => ({
  id: 'x', type: 'shape', kind, transform: { ...ident }, z: 1, createdAt: 1, updatedAt: 1, width: w, height: h, style: { ...style }, ...extra,
})
const resolve = () => undefined

describe('rounded corners', () => {
  it('radius is a quarter of the short side, capped at 32, and only for round shapes', () => {
    expect(cornerRadius(100, 60, 'sharp')).toBe(0)
    expect(cornerRadius(100, 60, 'round')).toBe(15)
    expect(cornerRadius(400, 300, 'round')).toBe(32)
  })
  it('a rounded rectangle outline stays inside the box and cuts the corners', () => {
    const o = shapeOutline('rectangle', 100, 60, { roundness: 'round' })
    expect(o.length).toBeGreaterThan(8)
    for (const p of o) { expect(p.x).toBeGreaterThanOrEqual(-1e-9); expect(p.y).toBeGreaterThanOrEqual(-1e-9); expect(p.x).toBeLessThanOrEqual(100); expect(p.y).toBeLessThanOrEqual(60) }
    expect(o.some((p) => p.x === 0 && p.y === 0)).toBe(false)
    expect(roundedPolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }], 15).d).toMatch(/^M0 15 C0 5 5 0 15 0L85 0 C95 0 100 5 100 15/)
  })
  it('rough geometry of a round rectangle is a curved path, a sharp one a rectangle', () => {
    const round = buildShapeGeometry(box('rectangle', 100, 60, { style: { ...style, roundness: 'round' } }), 'rough')
    const sharp = buildShapeGeometry(box('rectangle', 100, 60), 'rough')
    expect(round.strokes.flat().length).toBeGreaterThan(sharp.strokes.flat().length)
  })
  it('rounded outlines are drawn as joined strokes that start and end on the tangent points', () => {
    const shape = box('rectangle', 100, 60, { style: { ...style, roundness: 'round' } })
    const clean = buildShapeGeometry(shape, 'clean').strokes
    expect(clean).toHaveLength(1)
    expect(clean[0][0]).toEqual(clean[0].at(-1))
    const tangents = [[0, 15], [15, 0], [85, 0], [100, 15], [100, 45], [85, 60], [15, 60], [0, 45]].map(([x, y]) => ({ x, y }))
    const rough = buildShapeGeometry({ ...shape, style: { ...shape.style, roughness: 2 } }, 'rough').strokes
    for (const line of rough) {
      expect(tangents).toContainEqual(line[0])
      expect(tangents).toContainEqual(line.at(-1))
    }
  })
  it('diamond corners are proportional like Excalidraw: cut at a quarter of each edge', () => {
    const d = roundedShape('diamond', 400, 200, 'round')!.d
    expect(d).toMatch(/^M150 25 C200 0 200 0 250 25/)
    expect(roundedShape('diamond', 400, 200, 'sharp')).toBeUndefined()
  })
})

describe('highlighter edges', () => {
  const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]
  const xs = (o: { x: number }[]) => o.map((p) => p.x)
  it('flat ends stop at the stroke ends, round and slanted ends extend beyond them', () => {
    const flat = highlighterOutline(pts, 20, 'flat')
    expect(Math.min(...xs(flat))).toBeCloseTo(0)
    expect(Math.max(...xs(flat))).toBeCloseTo(100)
    const round = highlighterOutline(pts, 20, 'round')
    expect(Math.min(...xs(round))).toBeLessThan(-5)
    expect(Math.max(...xs(round))).toBeGreaterThan(105)
    const slanted = highlighterOutline(pts, 20, 'slanted')
    expect(Math.min(...xs(slanted))).toBeLessThan(0)
    expect(Math.max(...xs(slanted))).toBeGreaterThan(100)
  })
  it('curvy ends keep the full width and have a shallow wavy cut', () => {
    const o = highlighterOutline(pts, 20, 'curvy')
    const edge = o.filter((p) => p.x < 4)
    expect(Math.max(...edge.map((p) => p.y))).toBeGreaterThan(9)
    expect(Math.min(...edge.map((p) => p.y))).toBeLessThan(-9)
    expect(Math.max(...edge.map((p) => p.x)) - Math.min(...edge.map((p) => p.x))).toBeGreaterThan(2)
  })
  it('a sharp zigzag does not fold the outline over itself', () => {
    const zig = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 5, y: 6 }, { x: 100, y: 12 }]
    const o = highlighterOutline(zig, 20, 'flat')
    // the band stays within half a width (plus smoothing slack) of the path's bounding box
    for (const p of o) { expect(p.x).toBeGreaterThan(-25); expect(p.x).toBeLessThan(125); expect(p.y).toBeGreaterThan(-25); expect(p.y).toBeLessThan(37) }
    expect(o.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })
  it('a committed highlighter stroke uses its cap through strokeOutline', async () => {
    const { strokeOutline } = await import('../src/geometry/ink')
    const stroke: InkStroke = {
      id: 'h', type: 'ink', transform: { ...ident }, z: 1, createdAt: 1, updatedAt: 1, startedAt: 1, pointerType: 'pen',
      points: [0, 0, 0.5, 0, 0, 0, 100, 0, 0.5, 0, 0, 10], style: { tool: 'highlighter', color: '#ff0', width: 20, opacity: 0.4, pressureSensitive: false, cap: 'round' },
    }
    expect(Math.min(...xs(strokeOutline(stroke)))).toBeLessThan(-5)
  })
})

describe('lines with points, frames and blur masks', () => {
  it('a subdivided line is hit along its polyline, not its diagonal', () => {
    const l = box('line', 200, 100, { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }] })
    expect(hitTestObject(l, { x: 100, y: 98 }, 4, resolve)).toBe(true)
    expect(hitTestObject(l, { x: 100, y: 50 }, 4, resolve)).toBe(false)
    const g = buildShapeGeometry(l, 'clean').strokes.flat()
    expect(g.some((p) => Math.abs(p.x - 100) < 1e-6 && Math.abs(p.y - 100) < 1e-6)).toBe(true)
  })
  it('line handles: ends, interior points and segment middles in world space', () => {
    const l = box('line', 200, 100, { transform: { ...ident, x: 10, y: 20 }, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }] })
    const h = lineHandleSpecs(l)
    expect(h.map((x) => x.id)).toEqual(['start', 'end', 'wp:1', 'v:0', 'v:1'])
    expect(h[2].world).toEqual({ x: 110, y: 120 })
    expect(h[3].world).toEqual({ x: 60, y: 70 })
  })
  it('linePointsAfterDrag normalises to a unit-scale box with points at the origin', () => {
    const l = box('line', 100, 0, { transform: { ...ident, x: 10, y: 10, scaleX: -1 } }) // drawn right-to-left
    const g = linePointsAfterDrag(l, { insertAfter: 0 }, { x: -40, y: 60 })
    expect(g.transform).toMatchObject({ x: -90, y: 10, scaleX: 1, scaleY: 1 })
    expect(g.width).toBe(100)
    expect(g.height).toBe(50)
    expect(g.points).toEqual([{ x: 100, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 0 }])
    const removed = linePointsAfterDrag({ ...l, ...g }, { remove: 1 })
    expect(removed.points).toHaveLength(2)
  })
  it('frames are hit on the border and the name, not inside; blur masks are hit inside', () => {
    const f = box('frame', 300, 200, { label: 'Frame 1' })
    expect(hitTestObject(f, { x: 150, y: 100 }, 4, resolve)).toBe(false)
    expect(hitTestObject(f, { x: 150, y: 1 }, 4, resolve)).toBe(true)
    expect(hitTestObject(f, { x: 20, y: -10 }, 4, resolve)).toBe(true)
    const p = box('blur', 100, 100)
    expect(hitTestObject(p, { x: 50, y: 50 }, 4, resolve)).toBe(true)
    expect(buildShapeGeometry(p, 'rough').strokes).toEqual([])
  })
  it('elbow: dragging an end segment keeps the end point fixed and subdivides the route', () => {
    const path = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
    expect(elbowWaypointsAfterDrag(path, 0, { x: 50, y: 50 })).toEqual([{ x: 0, y: 50 }, { x: 100, y: 50 }])
    expect(elbowWaypointsAfterDrag(path, 1, { x: 160, y: 50 })).toEqual([{ x: 160, y: 0 }, { x: 160, y: 100 }])
  })
})

describe('ink stencil mesh and highlighter parts', () => {
  const allX = (parts: { x: number }[][]) => parts.flat().map((p) => p.x)
  const zig = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 4 }, { x: 160, y: 8 }]

  it('pen: one outline as a fan plus a cover quad, nonzero mode', async () => {
    const { MeshBuilder, VERTEX_FLOATS, buildInkStencilMesh } = await import('../src/geometry/mesh')
    const { strokeOutline } = await import('../src/geometry/ink')
    // a figure-eight: the outline crosses itself, which ear clipping fills wrongly
    const pts: number[] = []
    for (let i = 0; i <= 40; i++) { const t = (i / 40) * Math.PI * 2; pts.push(Math.sin(t) * 60, Math.sin(2 * t) * 30, 0.5, 0, 0, i * 8) }
    const stroke: InkStroke = {
      id: 'e', type: 'ink', transform: { ...ident }, z: 1, createdAt: 1, updatedAt: 1, startedAt: 1, pointerType: 'pen', points: pts,
      style: { tool: 'pen', color: '#000', width: 4, opacity: 1, pressureSensitive: false },
    }
    const mb = new MeshBuilder()
    const fill = buildInkStencilMesh(mb, stroke)
    expect(fill.union).toBe(false)
    expect(fill.fan).toBe((strokeOutline(stroke).length - 2) * 3)
    expect(mb.vertexCount - fill.fan).toBe(6)
    const cover = Array.from({ length: 6 }, (_, i) => mb.data[(fill.fan + i) * VERTEX_FLOATS])
    expect(Math.min(...cover)).toBeLessThan(-60)
    expect(Math.max(...cover)).toBeGreaterThan(60)
  })

  it('highlighter: segment bands and round joins stay covered through a reversal', async () => {
    const { highlighterParts, strokeFill } = await import('../src/geometry/ink')
    const parts = highlighterParts(zig, 20, 'flat')
    expect(parts).toHaveLength(5)
    // a reversal stays covered: the doubled-back segment has its own quad around y = 2
    expect(parts.some((p) => p.length === 4 && p.every((q) => q.x >= 30 && q.x <= 110))).toBe(true)
    const stroke: InkStroke = {
      id: 'h', type: 'ink', transform: { ...ident }, z: 1, createdAt: 1, updatedAt: 1, startedAt: 1, pointerType: 'pen',
      points: zig.flatMap((p, i) => [p.x, p.y, 0.5, 0, 0, i * 10]), style: { tool: 'highlighter', color: '#ff0', width: 20, opacity: 0.4, pressureSensitive: false },
    }
    expect(strokeFill(stroke).union).toBe(true)
  })

  it('caps: flat ends square, round and slanted reach past the ends, curvy stays full width', async () => {
    const { highlighterParts } = await import('../src/geometry/ink')
    const line = Array.from({ length: 11 }, (_, i) => ({ x: i * 20, y: 0 }))
    expect(Math.min(...allX(highlighterParts(line, 20, 'flat')))).toBeCloseTo(0)
    expect(Math.max(...allX(highlighterParts(line, 20, 'flat')))).toBeCloseTo(200)
    expect(Math.min(...allX(highlighterParts(line, 20, 'round')))).toBeCloseTo(-10)
    expect(Math.min(...allX(highlighterParts(line, 20, 'slanted')))).toBeCloseTo(-8)
    expect(Math.max(...allX(highlighterParts(line, 20, 'slanted')))).toBeCloseTo(208)
    const curvy = highlighterParts(line, 20, 'curvy')
    expect(curvy.flat().some((p) => p.x < 4 && Math.abs(p.y) === 10)).toBe(true)
    expect(Math.max(...curvy.flat().map((p) => Math.abs(p.y)))).toBeCloseTo(10)
  })

  it('curvy cuts work on sparse strokes and dense straight strokes keep the chisel cut', async () => {
    const { highlighterParts } = await import('../src/geometry/ink')
    const ends = [{ x: 0, y: 0 }, { x: 200, y: 0 }]
    const wavy = highlighterParts(ends, 20, 'curvy').flat()
    expect(Math.max(...wavy.map((p) => Math.abs(p.y)))).toBeCloseTo(10)
    const edge = wavy.filter((p) => p.x < 3)
    expect(Math.max(...edge.map((p) => p.y)) - Math.min(...edge.map((p) => p.y))).toBe(20)
    expect(Math.max(...edge.map((p) => p.x)) - Math.min(...edge.map((p) => p.x))).toBeGreaterThan(2)
    const dense = Array.from({ length: 201 }, (_, x) => ({ x, y: 0 }))
    expect(highlighterParts(dense, 20, 'slanted')).toEqual(highlighterParts(ends, 20, 'slanted'))
  })

  it('round parts have smooth edges and the same winding as the band', async () => {
    const { highlighterParts } = await import('../src/geometry/ink')
    const parts = highlighterParts([{ x: 0, y: 0 }, { x: 100, y: 0 }], 40, 'round')
    const area = (p: { x: number; y: number }[]) => p.reduce((sum, a, i) => {
      const b = p[(i + 1) % p.length]
      return sum + a.x * b.y - b.x * a.y
    }, 0)
    expect(parts.every((p) => area(p) < 0)).toBe(true)
    for (const circle of parts.slice(1)) {
      const a = circle[0], b = circle[1]
      expect(20 - Math.hypot((a.x + b.x) / 2 - a.x + 20, (a.y + b.y) / 2)).toBeLessThan(0.05)
    }
  })

  it.each(['flat', 'slanted'] as const)('%s cuts also trim nearby joints on dense curves', async (cap) => {
    const { highlighterParts } = await import('../src/geometry/ink')
    const pts = Array.from({ length: 51 }, (_, i) => ({ x: i * 2, y: 10 * Math.sin(i / 12) }))
    const parts = highlighterParts(pts, 20, cap)
    const first = pts[0], second = { x: (pts[0].x + 2 * pts[1].x + pts[2].x) / 4, y: (pts[0].y + 2 * pts[1].y + pts[2].y) / 4 }
    const len = Math.hypot(second.x - first.x, second.y - first.y)
    const dx = (second.x - first.x) / len, dy = (second.y - first.y) / len
    const slant = cap === 'slanted' ? 0.8 : 0
    for (const p of parts.flat()) {
      expect(p.x * dx + p.y * dy + slant * (p.y * dx - p.x * dy)).toBeGreaterThanOrEqual(-1e-8)
    }
  })
})
