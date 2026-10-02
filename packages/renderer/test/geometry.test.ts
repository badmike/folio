import { describe, expect, it } from 'vitest'
import rough from 'roughjs'
import { catmullRom, catmullRomSvg } from '../src/geometry/curves'
import { strokeOutline, triangulate, freehandOptions } from '../src/geometry/ink'
import { buildArrowGeometry, buildShapeGeometry, opsetToPolylines } from '../src/geometry/rough'
import { MeshBuilder, addPolyline, addPolygon, buildInkMesh, buildShapeMesh, buildArrowMesh, VERTEX_FLOATS } from '../src/geometry/mesh'
import { boundsOfPoints, polygonArea } from '../src/math'
import { parseColor, premultiplied } from '../src/color'
import { arrow, ink, shape } from './helpers'

function meshArea(mb: MeshBuilder): number {
  const d = mb.view()
  let a = 0
  for (let i = 0; i < d.length; i += VERTEX_FLOATS * 3) {
    const [ax, ay, bx, by, cx, cy] = [d[i], d[i + 1], d[i + 6], d[i + 7], d[i + 12], d[i + 13]]
    a += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
  }
  return a
}

describe('strokeOutline / triangulate', () => {
  const pts: [number, number, number][] = Array.from({ length: 30 }, (_, i) => [i * 5, Math.sin(i / 4) * 10, 0.5])

  it('returns a polygon around the stroke', () => {
    const o = strokeOutline(ink('a', pts))
    expect(o.length).toBeGreaterThan(20)
    const b = boundsOfPoints(o)
    expect(b.width).toBeGreaterThan(140)
    expect(o.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })

  it('empty stroke gives empty outline; single point gives a dot', () => {
    expect(strokeOutline(ink('e', []))).toEqual([])
    const dot = strokeOutline(ink('d', [[10, 10, 0.5]]))
    expect(dot.length).toBeGreaterThan(3)
  })

  it('higher pressure gives a thicker stroke when pressure sensitive', () => {
    const line = (p: number) => Array.from({ length: 20 }, (_, i) => [i * 6, 0, p] as [number, number, number])
    const thin = boundsOfPoints(strokeOutline(ink('t', line(0.1)))).height
    const thick = boundsOfPoints(strokeOutline(ink('k', line(0.9)))).height
    expect(thick).toBeGreaterThan(thin * 1.5)
  })

  it('highlighter is flat (no thinning, no simulated pressure)', () => {
    const o = freehandOptions(ink('h', [], { style: { tool: 'highlighter', color: '#ff0', width: 16, opacity: 0.4, pressureSensitive: false } }))
    expect(o.thinning).toBe(0)
    expect(o.simulatePressure).toBe(false)
  })

  it('mouse strokes simulate pressure', () => {
    expect(freehandOptions(ink('m', [], { pointerType: 'mouse' })).simulatePressure).toBe(true)
    expect(freehandOptions(ink('m', [], { pointerType: 'pen' })).simulatePressure).toBe(false)
  })

  it('triangulation covers the polygon area', () => {
    const o = strokeOutline(ink('a', pts))
    const idx = triangulate(o)
    expect(idx.length % 3).toBe(0)
    expect(idx.length).toBeGreaterThan(0)
    let area = 0
    for (let i = 0; i < idx.length; i += 3) area += polygonArea([o[idx[i]], o[idx[i + 1]], o[idx[i + 2]]])
    expect(area).toBeGreaterThan(0)
    expect(area / polygonArea(o)).toBeGreaterThan(0.9)
    expect(area / polygonArea(o)).toBeLessThan(1.1)
  })

  it('triangulates a square into two triangles', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    expect(triangulate(sq)).toHaveLength(6)
    expect(triangulate(sq.slice(0, 2))).toEqual([])
  })

  it('ink mesh has finite triangles', () => {
    const mb = new MeshBuilder()
    buildInkMesh(mb, ink('a', pts))
    expect(mb.vertexCount % 3).toBe(0)
    expect(mb.vertexCount).toBeGreaterThan(0)
    expect(mb.view().every(Number.isFinite)).toBe(true)
  })
})

describe('rough geometry', () => {
  it('is deterministic for the same seed and differs across seeds', () => {
    const a = buildShapeGeometry(shape('s', 'rectangle', 100, 60), 'rough')
    const b = buildShapeGeometry(shape('s', 'rectangle', 100, 60), 'rough')
    const c = buildShapeGeometry(shape('s', 'rectangle', 100, 60, {}, { seed: 43 }), 'rough')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c))
  })

  it('seed 0 is still deterministic', () => {
    const mk = () => buildShapeGeometry(shape('s', 'ellipse', 80, 50, {}, { seed: 0 }), 'rough')
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()))
  })

  it('clean theme yields exact geometric rectangle lines', () => {
    const g = buildShapeGeometry(shape('s', 'rectangle', 100, 60), 'clean')
    const pts = g.strokes.flat()
    const b = boundsOfPoints(pts)
    expect(b.x).toBeCloseTo(0)
    expect(b.y).toBeCloseTo(0)
    expect(b.width).toBeCloseTo(100)
    expect(b.height).toBeCloseTo(60)
  })

  it('rough theme wobbles beyond the exact box', () => {
    const g = buildShapeGeometry(shape('s', 'rectangle', 100, 60, {}, { roughness: 3 }), 'rough')
    const b = boundsOfPoints(g.strokes.flat())
    expect(b.width !== 100 || b.height !== 60).toBe(true)
  })

  it('fills: solid polygons when clean, hachure lines when rough', () => {
    const clean = buildShapeGeometry(shape('s', 'diamond', 100, 60, {}, { fillColor: '#f00' }), 'clean')
    expect(clean.fills.length).toBeGreaterThan(0)
    const rough = buildShapeGeometry(shape('s', 'diamond', 100, 60, {}, { fillColor: '#f00' }), 'rough')
    expect(rough.hatch.length).toBeGreaterThan(0)
    const none = buildShapeGeometry(shape('s', 'diamond', 100, 60), 'rough')
    expect(none.hatch.length + none.fills.length).toBe(0)
  })

  it('covers every shape kind', () => {
    for (const k of ['rectangle', 'ellipse', 'triangle', 'diamond', 'line'] as const) {
      const g = buildShapeGeometry(shape('s', k, 90, 50), 'rough')
      expect(g.strokes.length).toBeGreaterThan(0)
      expect(g.strokes.flat().every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
    }
  })

  it('flattens bezier ops', () => {
    const lines = opsetToPolylines({
      type: 'path',
      ops: [
        { op: 'move', data: [0, 0] },
        { op: 'bcurveTo', data: [0, 10, 10, 10, 10, 0] },
        { op: 'lineTo', data: [20, 0] },
      ],
    }, 8)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(1 + 8 + 1)
    expect(lines[0][8]).toEqual({ x: 10, y: 0 })
  })

  it('arrow: shaft + head at end only / both', () => {
    const a = arrow('a', { x: 0, y: 0 }, { x: 100, y: 0 })
    const one = buildArrowGeometry(a, [a.start, a.end], 'clean')
    expect(one.strokes).toHaveLength(2) // shaft + one barb polyline (a-tip-b)
    const both = buildArrowGeometry({ ...a, startHead: 'arrow' }, [a.start, a.end], 'clean')
    expect(both.strokes).toHaveLength(3)
    const none = buildArrowGeometry({ ...a, endHead: 'none' }, [a.start, a.end], 'clean')
    expect(none.strokes).toHaveLength(1)
    // head barbs end at the tip
    const tip = one.strokes[1][1]
    expect(Math.abs(tip.x - 100)).toBeLessThan(1)
    expect(buildArrowGeometry(a, [a.start, a.start], 'clean').strokes).toHaveLength(0)
  })

  it('rough arrows keep shaft endpoints and arrow tips attached at every sloppiness', () => {
    for (const roughness of [1, 2, 3]) {
      const a = arrow('a', { x: 0, y: 0 }, { x: 200, y: 0 })
      a.style.roughness = roughness
      const g = buildArrowGeometry(a, [a.start, a.end], 'rough')
      expect(g.strokes[0][0]).toEqual(a.start)
      expect(g.strokes[0].at(-1)).toEqual(a.end)
      expect(g.strokes.slice(2).every((line) => line.some((p) => p.x === a.end.x && p.y === a.end.y))).toBe(true)
      expect(g.strokes[0].some((p) => p.y !== 0)).toBe(true)
    }
  })

  it('curved shafts use two seeded passes and respond to maximum sloppiness', () => {
    const a = arrow('a', { x: 0, y: 0 }, { x: 240, y: 0 }, { arrowType: 'curved', waypoints: [{ x: 120, y: 80 }], endHead: 'none' })
    const path = catmullRom([a.start, ...a.waypoints!, a.end]).path
    const g = buildArrowGeometry(a, path, 'rough')
    expect(g.strokes).toHaveLength(3) // two passes per cubic segment, joined where one ends at the next start
    expect(g).toEqual(buildArrowGeometry(a, path, 'rough'))
    for (const line of g.strokes) {
      expect([a.start, ...a.waypoints!]).toContainEqual(line[0])
      expect([...a.waypoints!, a.end]).toContainEqual(line.at(-1))
    }
    const more = (roughness: number) => buildArrowGeometry({ ...a, style: { ...a.style, roughness } }, path, 'rough')
    expect(more(2).strokes).not.toEqual(more(3).strokes)
    expect(buildArrowGeometry(a, path, 'clean').strokes).toEqual([path])
  })

  it('cubic curve geometry matches the curve used for handles and hit tests', () => {
    const points = [{ x: 0, y: 0 }, { x: 80, y: 60 }, { x: 160, y: 0 }]
    const expected = catmullRom(points, 10).path
    const drawable = rough.generator().path(catmullRomSvg(points), { roughness: 0, preserveVertices: true, disableMultiStroke: true })
    const lines = opsetToPolylines(drawable.sets[0])
    const actual = [lines[0][0], ...lines.flatMap((line) => line.slice(1))]
    expect(actual).toHaveLength(expected.length)
    actual.forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i].x, 8)
      expect(p.y).toBeCloseTo(expected[i].y, 8)
    })
  })

  it('rough dashed shafts keep clear gaps and solid connected heads', () => {
    const a = arrow('a', { x: 0, y: 0 }, { x: 200, y: 0 })
    a.style.strokeStyle = 'dashed'
    const g = buildArrowGeometry(a, [a.start, a.end], 'rough')
    const shaft = g.strokes.filter((line) => !line.some((p) => p.x === 200 && p.y === 0))
    expect(shaft.length).toBeGreaterThan(3)
    for (let i = 1; i < shaft.length; i++) expect(shaft[i][0].x - shaft[i - 1].at(-1)!.x).toBeGreaterThan(5)
    expect(g.strokes.slice(-4).every((line) => line.some((p) => p.x === 200 && p.y === 0))).toBe(true)
  })

  it('meshes for shapes and arrows are non-empty and finite', () => {
    const mb = new MeshBuilder()
    buildShapeMesh(mb, shape('s', 'ellipse', 80, 50, {}, { fillColor: '#0f0' }), 'rough')
    const n = mb.vertexCount
    expect(n).toBeGreaterThan(30)
    buildArrowMesh(mb, arrow('a', { x: 0, y: 0 }, { x: 50, y: 50 }), [{ x: 0, y: 0 }, { x: 50, y: 50 }], 'clean')
    expect(mb.vertexCount).toBeGreaterThan(n)
    expect(mb.view().every(Number.isFinite)).toBe(true)
  })
})

describe('thick lines', () => {
  it('straight segment covers ~ length × width', () => {
    const mb = new MeshBuilder()
    addPolyline(mb, [{ x: 0, y: 0 }, { x: 100, y: 0 }], 4, [0, 0, 0, 1])
    expect(meshArea(mb)).toBeGreaterThan(390)
    expect(meshArea(mb)).toBeLessThan(420)
  })

  it('mitred corner does not double cover much and stays bounded', () => {
    const mb = new MeshBuilder()
    addPolyline(mb, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], 4, [0, 0, 0, 1])
    const b = boundsOfPoints(Array.from({ length: mb.vertexCount }, (_, i) => ({ x: mb.data[i * 6], y: mb.data[i * 6 + 1] })))
    expect(b.x).toBeGreaterThan(-3)
    expect(b.width).toBeLessThan(57)
  })

  it('sharp reversal is bevelled, not spiking', () => {
    const mb = new MeshBuilder()
    addPolyline(mb, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 1 }], 4, [0, 0, 0, 1])
    const xs = Array.from({ length: mb.vertexCount }, (_, i) => mb.data[i * 6])
    expect(Math.max(...xs)).toBeLessThan(60)
  })

  it('closed polylines and degenerate input', () => {
    const mb = new MeshBuilder()
    addPolyline(mb, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }], 2, [0, 0, 0, 1], true)
    expect(mb.vertexCount).toBeGreaterThan(20)
    const m2 = new MeshBuilder()
    addPolyline(m2, [{ x: 5, y: 5 }, { x: 5, y: 5 }], 2, [0, 0, 0, 1])
    expect(m2.vertexCount).toBeGreaterThan(0) // dot
    const m3 = new MeshBuilder()
    addPolygon(m3, [{ x: 0, y: 0 }, { x: 1, y: 1 }], [0, 0, 0, 1])
    expect(m3.vertexCount).toBe(0)
  })

  it('mesh builder grows beyond initial capacity', () => {
    const mb = new MeshBuilder()
    for (let i = 0; i < 20000; i++) mb.tri(0, 0, 1, 0, 0, 1, [1, 1, 1, 1])
    expect(mb.vertexCount).toBe(60000)
    mb.reset()
    expect(mb.vertexCount).toBe(0)
  })
})

describe('color', () => {
  it('parses formats', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0, 1])
    expect(parseColor('#00ff0080')[3]).toBeCloseTo(0.5, 2)
    expect(parseColor('rgb(255, 0, 0)')).toEqual([1, 0, 0, 1])
    expect(parseColor('rgba(0,0,255,0.5)')).toEqual([0, 0, 1, 0.5])
    expect(parseColor('hsl(120, 100%, 50%)')[1]).toBeCloseTo(1)
    expect(parseColor('transparent')[3]).toBe(0)
    expect(parseColor(undefined)).toEqual([0, 0, 0, 1])
  })
  it('premultiplies with opacity', () => {
    expect(premultiplied('#ffffff', 0.5)).toEqual([0.5, 0.5, 0.5, 0.5])
  })
})

describe('arrow label layout', () => {
  it('fit shrinks the label box to the text so the background does not cover the shaft', async () => {
    const { labelLayout, setTextMeasurer } = await import('../src/text')
    setTextMeasurer((_f, t) => t.length * 9)
    const wide = labelLayout('clean up', 160, false)
    const fit = labelLayout('clean up', 160, false, true)
    expect(wide.width).toBe(144)
    expect(fit.width).toBe(72)
    expect(fit.height).toBe(wide.height)
    setTextMeasurer(null)
  })
})
