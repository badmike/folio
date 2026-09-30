import { beforeAll, describe, expect, it } from 'vitest'
import { adaptColor } from '@folio/document'
import type { ArrowObject, CanvasObject, Vec2 } from '@folio/document'
import { Canvas2DRenderer } from '../src/canvas2d'
import { arrowHandleSpecs, arrowPath, elbowWaypointsAfterDrag, resolveArrowEndpoints } from '../src/arrows'
import { backgroundLevels, patternColor, patternCoverageLevels, patternFade, patternLevels } from '../src/background'
import { catmullRom, dashPattern, dashPolyline, orthogonalRoute } from '../src/geometry/curves'
import { arrowheadParts, buildArrowGeometry, buildShapeGeometry, pathEndTangent } from '../src/geometry/rough'
import { createLiveInkLayer } from '../src/live-ink'
import { objectWorldBounds } from '../src/bounds'
import { hitTestObject, objectIntersectsRect } from '../src/hit'
import { arrow, ink, PAGE, scene, shape, text, useFakeMeasure } from './helpers'

beforeAll(useFakeMeasure)

const len = (p: Vec2[]) => p.reduce((l, q, i) => (i ? l + Math.hypot(q.x - p[i - 1].x, q.y - p[i - 1].y) : 0), 0)
const resolverOf = (objs: CanvasObject[]) => {
  const m = new Map(objs.map((o) => [o.id, o]))
  return (id: string) => m.get(id)
}

describe('dashes', () => {
  it('patterns are proportional to stroke width', () => {
    expect(dashPattern('solid', 2)).toBeNull()
    expect(dashPattern(undefined, 2)).toBeNull()
    const [d1, g1] = dashPattern('dashed', 2)!
    const [d2, g2] = dashPattern('dashed', 4)!
    expect(d2).toBeGreaterThan(d1)
    expect(g2).toBeGreaterThan(g1)
    const [dd, dg] = dashPattern('dotted', 4)!
    expect(dd).toBeLessThan(dg)
  })

  it('splits a straight line into dash/gap runs of the given lengths', () => {
    const out = dashPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10, 5)
    // period 15 → dashes start at 0,15,...,90 (7 dashes, the last one 90-100)
    expect(out).toHaveLength(7)
    expect(out[0]).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }])
    expect(out[1][0].x).toBeCloseTo(15)
    expect(out[6][1].x).toBeCloseTo(100)
    const total = out.reduce((s, d) => s + len(d), 0)
    expect(total).toBeCloseTo(70)
  })

  it('carries the dash phase around corners', () => {
    const out = dashPolyline([{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 25 }], 10, 10)
    const total = out.reduce((s, d) => s + len(d), 0)
    expect(total).toBeCloseTo(30, 5) // 50 length: dashes 0-10, 20-30, 40-50
    const bent = out.find((d) => d.length === 3)
    expect(bent).toBeTruthy() // the dash spanning the corner keeps the vertex
  })

  it('shape and arrow geometry apply strokeStyle (rough theme too)', () => {
    const solid = buildShapeGeometry(shape('s', 'rectangle', 200, 100, {}, { roughness: 1 }), 'rough')
    const dashed = buildShapeGeometry(shape('s', 'rectangle', 200, 100, {}, { roughness: 1, strokeStyle: 'dashed' }), 'rough')
    expect(dashed.strokes.length).toBeGreaterThan(solid.strokes.length * 3)
    const dotted = buildShapeGeometry(shape('s', 'ellipse', 100, 100, {}, { roughness: 0, strokeStyle: 'dotted' }), 'clean')
    expect(dotted.strokes.length).toBeGreaterThan(20)
    const a = arrow('a', { x: 0, y: 0 }, { x: 200, y: 0 }, { style: { strokeColor: '#000', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1, strokeStyle: 'dashed' } })
    const g = buildArrowGeometry(a, [a.start, a.end], 'clean')
    expect(g.strokes.length).toBeGreaterThan(8)
    // the head stays a solid open polyline
    expect(g.strokes.some((l) => l.length === 3)).toBe(true)
  })

  it('fillStyle is passed through (hachure / cross-hatch / solid)', () => {
    const base = { fillColor: '#f00', roughness: 1 }
    const solid = buildShapeGeometry(shape('s', 'rectangle', 120, 80, {}, { ...base, fillStyle: 'solid' }), 'rough')
    const hach = buildShapeGeometry(shape('s', 'rectangle', 120, 80, {}, { ...base, fillStyle: 'hachure' }), 'rough')
    const cross = buildShapeGeometry(shape('s', 'rectangle', 120, 80, {}, { ...base, fillStyle: 'cross-hatch' }), 'rough')
    expect(solid.fills.length).toBeGreaterThan(0)
    expect(solid.hatch).toHaveLength(0)
    expect(hach.hatch.length).toBeGreaterThan(3)
    expect(cross.hatch.length).toBeGreaterThan(hach.hatch.length)
    // clean theme: hachure is straight parallel lines
    const clean = buildShapeGeometry(shape('s', 'rectangle', 120, 80, {}, { ...base, fillStyle: 'hachure' }), 'clean')
    expect(clean.hatch.length).toBeGreaterThan(3)
    for (const l of clean.hatch) {
      const a = l[0], b = l[l.length - 1]
      for (const q of l) expect(Math.abs((b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x))).toBeLessThan(1e-6)
    }
  })
})

describe('arrowheads', () => {
  const style = { strokeColor: '#000', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1 }
  it('arrow: two barbs meeting at the tip, symmetric about the direction', () => {
    const p = arrowheadParts('arrow', { x: 100, y: 0 }, { x: 1, y: 0 }, style, 200)
    expect(p.solids).toHaveLength(0)
    const [a, tip, b] = p.strokes[0]
    expect(tip).toEqual({ x: 100, y: 0 })
    expect(a.x).toBeLessThan(100)
    expect(a.y).toBeCloseTo(-b.y)
  })
  it('triangle: filled polygon with the tip first', () => {
    const p = arrowheadParts('triangle', { x: 0, y: 100 }, { x: 0, y: 1 }, style, 200)
    expect(p.strokes).toHaveLength(0)
    expect(p.solids[0]).toHaveLength(3)
    expect(p.solids[0][0]).toEqual({ x: 0, y: 100 })
    expect(p.solids[0][1].y).toBeLessThan(100)
  })
  it('dot: circle just behind the tip; bar: perpendicular line through the tip', () => {
    const dot = arrowheadParts('dot', { x: 50, y: 50 }, { x: 1, y: 0 }, style, 200).solids[0]
    const cx = dot.reduce((s, q) => s + q.x, 0) / dot.length
    expect(cx).toBeLessThan(50)
    expect(Math.max(...dot.map((q) => q.x))).toBeCloseTo(50, 5)
    const bar = arrowheadParts('bar', { x: 50, y: 50 }, { x: 1, y: 0 }, style, 200).strokes[0]
    expect(bar[0].x).toBeCloseTo(50)
    expect(bar[1].x).toBeCloseTo(50)
    expect(bar[0].y).toBeCloseTo(-bar[1].y + 100)
    expect(arrowheadParts('none', { x: 0, y: 0 }, { x: 1, y: 0 }, style, 10)).toEqual({ strokes: [], solids: [] })
  })
  it('is oriented along the path tangent at both ends', () => {
    const path = catmullRom([{ x: 0, y: 0 }, { x: 50, y: 60 }, { x: 100, y: 0 }]).path
    const t = pathEndTangent(path, true)
    expect(t.x).toBeGreaterThan(0)
    expect(t.y).toBeLessThan(0) // arch: arriving upwards at the end
    const s = pathEndTangent(path, false)
    expect(s.x).toBeLessThan(0) // pointing out of the start = backwards
    expect(s.y).toBeLessThan(0)
    expect(Math.hypot(t.x, t.y)).toBeCloseTo(1)
  })
  it('geometry adds solid polygons for triangle/dot and filled heads render with the stroke colour', () => {
    const a = arrow('a', { x: 0, y: 0 }, { x: 100, y: 0 }, { endHead: 'triangle', startHead: 'dot', style })
    const g = buildArrowGeometry(a, [a.start, a.end], 'clean')
    expect(g.solids).toHaveLength(2)
  })
})

describe('curved arrows', () => {
  it('without waypoints is straight; with waypoints passes through them smoothly', () => {
    const a = arrow('c', { x: 0, y: 0 }, { x: 200, y: 0 }, { arrowType: 'curved' })
    const res = resolverOf([a])
    expect(arrowPath(a, res)).toEqual([{ x: 0, y: 0 }, { x: 200, y: 0 }])
    const b = { ...a, waypoints: [{ x: 100, y: 80 }] }
    const p = arrowPath(b, res)
    expect(p.length).toBeGreaterThan(10)
    expect(p[0]).toEqual({ x: 0, y: 0 })
    expect(p[p.length - 1]).toEqual({ x: 200, y: 0 })
    expect(p.some((q) => Math.hypot(q.x - 100, q.y - 80) < 1e-6)).toBe(true)
    // smooth: no sharp turns between consecutive samples
    for (let i = 2; i < p.length; i++) {
      const d0 = { x: p[i - 1].x - p[i - 2].x, y: p[i - 1].y - p[i - 2].y }
      const d1 = { x: p[i].x - p[i - 1].x, y: p[i].y - p[i - 1].y }
      const cos = (d0.x * d1.x + d0.y * d1.y) / (Math.hypot(d0.x, d0.y) * Math.hypot(d1.x, d1.y))
      expect(cos).toBeGreaterThan(0.9)
    }
    // it bulges to the waypoint side
    expect(Math.max(...p.map((q) => q.y))).toBeGreaterThanOrEqual(80 - 1e-6)
  })

  it('multiple waypoints all lie on the curve', () => {
    const pts = [{ x: 50, y: 30 }, { x: 100, y: -40 }, { x: 150, y: 20 }]
    const a = arrow('c', { x: 0, y: 0 }, { x: 200, y: 0 }, { arrowType: 'curved', waypoints: pts })
    const p = arrowPath(a, resolverOf([a]))
    for (const w of pts) expect(p.some((q) => Math.hypot(q.x - w.x, q.y - w.y) < 1e-6)).toBe(true)
  })

  it('bound endpoints aim towards the first / last waypoint', () => {
    const s = shape('s', 'rectangle', 100, 100)
    const e = shape('e', 'rectangle', 100, 100, { transform: { x: 300, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } })
    const a = arrow('a', { x: 50, y: 50 }, { x: 350, y: 50 }, {
      arrowType: 'curved', startBinding: { objectId: 's' }, endBinding: { objectId: 'e' }, waypoints: [{ x: 150, y: -200 }],
    })
    const res = resolverOf([s, e, a])
    const straight = resolveArrowEndpoints({ ...a, arrowType: 'straight' }, res)
    expect(straight.start.x).toBeCloseTo(100) // leaves through the right edge
    const curved = resolveArrowEndpoints(a, res)
    expect(curved.start.y).toBeCloseTo(0) // aimed up at the waypoint: exits through the top edge
    expect(curved.end.y).toBeCloseTo(0)
  })

  it('handles: ends, waypoints and one virtual handle per segment on the curve', () => {
    const a = arrow('c', { x: 0, y: 0 }, { x: 200, y: 0 }, { arrowType: 'curved', waypoints: [{ x: 100, y: 80 }] })
    const hs = arrowHandleSpecs(a, resolverOf([a]))
    expect(hs.map((h) => h.id)).toEqual(['start', 'end', 'wp:0', 'v:0', 'v:1'])
    expect(hs.find((h) => h.id === 'wp:0')!.kind).toBe('waypoint')
    const bare = arrowHandleSpecs({ ...a, waypoints: undefined }, resolverOf([a]))
    expect(bare.map((h) => h.id)).toEqual(['start', 'end', 'v:0'])
    expect(bare[2].world).toEqual({ x: 100, y: 0 })
  })
})

describe('elbow arrows', () => {
  const axisAligned = (p: Vec2[]) => p.every((q, i) => i === 0 || Math.abs(q.x - p[i - 1].x) < 1e-6 || Math.abs(q.y - p[i - 1].y) < 1e-6)

  it('unbound: all segments axis aligned, starts and ends at the free points', () => {
    const a = arrow('e', { x: 0, y: 0 }, { x: 200, y: 120 }, { arrowType: 'elbow' })
    const p = arrowPath(a, resolverOf([a]))
    expect(axisAligned(p)).toBe(true)
    expect(p[0]).toEqual({ x: 0, y: 0 })
    expect(p[p.length - 1]).toEqual({ x: 200, y: 120 })
    expect(p.length).toBeGreaterThanOrEqual(3)
  })

  it('bound shapes side by side: leaves right perpendicular, enters left perpendicular', () => {
    const s = shape('s', 'rectangle', 100, 60)
    const e = shape('e', 'rectangle', 100, 60, { transform: { x: 300, y: 100, rotation: 0, scaleX: 1, scaleY: 1 } })
    const a = arrow('a', { x: 50, y: 30 }, { x: 350, y: 130 }, { arrowType: 'elbow', startBinding: { objectId: 's' }, endBinding: { objectId: 'e' } })
    const p = arrowPath(a, resolverOf([s, e, a]))
    expect(axisAligned(p)).toBe(true)
    expect(p[0]).toEqual({ x: 100, y: 30 }) // right edge midpoint of s
    expect(p[1].y).toBeCloseTo(30) // first segment horizontal (perpendicular to the right edge)
    expect(p[1].x).toBeGreaterThan(100)
    const n = p.length
    expect(p[n - 1]).toEqual({ x: 300, y: 130 }) // left edge midpoint of e
    expect(p[n - 2].y).toBeCloseTo(130) // last segment horizontal, arriving from the left
    expect(p[n - 2].x).toBeLessThan(300)
    // resolveArrowEndpoints reports the route's ends
    const ends = resolveArrowEndpoints(a, resolverOf([s, e, a]))
    expect(ends.start).toEqual(p[0])
    expect(ends.end).toEqual(p[n - 1])
  })

  it('stacked shapes exit bottom / enter top', () => {
    const s = shape('s', 'rectangle', 100, 60)
    const e = shape('e', 'rectangle', 100, 60, { transform: { x: 20, y: 250, rotation: 0, scaleX: 1, scaleY: 1 } })
    const a = arrow('a', { x: 50, y: 30 }, { x: 70, y: 280 }, { arrowType: 'elbow', startBinding: { objectId: 's' }, endBinding: { objectId: 'e' } })
    const p = arrowPath(a, resolverOf([s, e, a]))
    expect(axisAligned(p)).toBe(true)
    expect(p[0]).toEqual({ x: 50, y: 60 })
    expect(p[1].x).toBeCloseTo(50)
    expect(p[1].y).toBeGreaterThan(60)
    const n = p.length
    expect(p[n - 1]).toEqual({ x: 70, y: 250 })
    expect(p[n - 2].x).toBeCloseTo(70)
    expect(p[n - 2].y).toBeLessThan(250)
  })

  it('waypoints act as fixed corners', () => {
    const a = arrow('e', { x: 0, y: 0 }, { x: 200, y: 100 }, { arrowType: 'elbow', waypoints: [{ x: 60, y: 0 }, { x: 60, y: 100 }] })
    const p = arrowPath(a, resolverOf([a]))
    expect(axisAligned(p)).toBe(true)
    expect(p).toEqual([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 100 }, { x: 200, y: 100 }])
  })

  it('orthogonalRoute honours leave/arrive directions and never folds back', () => {
    const r = orthogonalRoute({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -100, y: 0 }, { x: 1, y: 0 })
    expect(axisAligned(r)).toBe(true)
      expect(r[1].x).toBeGreaterThanOrEqual(0) // never leaves against the exit direction
    expect(r.length).toBeGreaterThan(2) // has to go around
  })

  it('dragging a middle segment yields waypoints reproducing the moved route', () => {
    const s = shape('s', 'rectangle', 100, 60)
    const e = shape('e', 'rectangle', 100, 60, { transform: { x: 300, y: 100, rotation: 0, scaleX: 1, scaleY: 1 } })
    const a = arrow('a', { x: 50, y: 30 }, { x: 350, y: 130 }, { arrowType: 'elbow', startBinding: { objectId: 's' }, endBinding: { objectId: 'e' } })
    const res = resolverOf([s, e, a])
    const p = arrowPath(a, res)
    const hs = arrowHandleSpecs(a, res).filter((h) => h.kind === 'virtual')
    expect(hs.length).toBeGreaterThan(0)
    // find the vertical middle segment
    const seg = p.findIndex((q, i) => i > 0 && i < p.length - 2 && Math.abs(q.x - p[i + 1].x) < 1e-6 && Math.abs(q.y - p[i + 1].y) > 1)
    expect(seg).toBeGreaterThan(0)
    const wps = elbowWaypointsAfterDrag(p, seg, { x: p[seg].x + 40, y: 0 })
    const moved = arrowPath({ ...a, waypoints: wps }, res)
    expect(axisAligned(moved)).toBe(true)
    expect(moved.some((q, i) => i > 0 && Math.abs(q.x - (p[seg].x + 40)) < 1e-6 && Math.abs(moved[i - 1].x - q.x) < 1e-6)).toBe(true)
    expect(moved[0]).toEqual(p[0])
    expect(moved[moved.length - 1]).toEqual(p[p.length - 1])
  })
})

describe('arrow bounds, hit testing and selection', () => {
  const a = arrow('c', { x: 0, y: 0 }, { x: 200, y: 0 }, { arrowType: 'curved', waypoints: [{ x: 100, y: 120 }] })
  const res = resolverOf([a])
  it('bounds cover the curve, hit tests follow it', () => {
    const b = objectWorldBounds(a, res)!
    expect(b.y + b.height).toBeGreaterThanOrEqual(120)
    expect(hitTestObject(a, { x: 100, y: 120 }, 4, res)).toBe(true)
    expect(hitTestObject(a, { x: 100, y: 0 }, 4, res)).toBe(false) // the straight chord is not the arrow
    expect(objectIntersectsRect(a, { x: 90, y: 110, width: 20, height: 20 }, res)).toBe(true)
    expect(objectIntersectsRect(a, { x: 90, y: -10, width: 20, height: 20 }, res)).toBe(false)
  })
})

describe('dynamic background scaling', () => {
  it('picks a level whose screen spacing is in [12, 60) and cross-fades the finer one', () => {
    for (const zoom of [0.05, 0.2, 0.37, 1, 1.9, 4, 17]) {
      const lv = patternLevels(32, 5, zoom, 'dynamic')
      const px = lv[0].spacing * zoom
      expect(px).toBeGreaterThanOrEqual(12 - 1e-6)
      expect(px).toBeLessThan(60 + 1e-6)
      expect(lv[0].alpha).toBe(1)
      // spacing is s·k^n
      const n = Math.log(lv[0].spacing / 32) / Math.log(5)
      expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-9)
      if (lv[1]) expect(lv[1].spacing).toBeCloseTo(lv[0].spacing / 5)
    }
  })
  it('fine level fades in as the primary grows and is continuous across the switch', () => {
    const at = (px: number) => patternLevels(100, 5, px / 100, 'dynamic')
    expect(at(12.01)[1]?.alpha ?? 0).toBeLessThan(0.01)
    expect(at(59.9)[1].alpha).toBeGreaterThan(0.99)
    const mid = at(25)[1].alpha
    expect(mid).toBeGreaterThan(0.1)
    expect(mid).toBeLessThan(0.9)
    // just before/after the level switch the visible line sets are identical
    const before = at(59.99)
    const after = at(60.01)
    expect(before[0].spacing).toBeCloseTo(100 / 100 * 100)
    expect(after[0].spacing).toBeCloseTo(before[0].spacing / 5)
    expect(before[1].spacing).toBeCloseTo(after[0].spacing)
    expect(before[1].alpha).toBeCloseTo(1, 1)
    expect(after[0].alpha).toBe(1)
    // monotone fade within a level
    let prev = -1
    for (let px = 12; px < 60; px += 4) {
      const a2 = at(px)[1]?.alpha ?? 0
      expect(a2).toBeGreaterThanOrEqual(prev)
      prev = a2
    }
  })
  it('respects the subdivisions parameter', () => {
    const lv = patternLevels(10, 4, 1, 'dynamic', 12)
    const ratio = lv[0].spacing / 10
    expect(Math.abs(Math.log(ratio) / Math.log(4) - Math.round(Math.log(ratio) / Math.log(4)))).toBeLessThan(1e-9)
  })
  it('fixed scaling keeps the spacing and fades out below ~6px instead of aliasing', () => {
    expect(patternLevels(32, 5, 1, 'fixed')).toEqual([{ spacing: 32, alpha: 1 }])
    expect(patternLevels(32, 5, 0.1, 'fixed')[0].alpha).toBeCloseTo(0.067, 2) // 3.2px → nearly gone
    expect(patternLevels(32, 5, 0.05, 'fixed')).toEqual([])
    expect(patternFade(10, 0.5)).toBeCloseTo(0.667, 2)
    expect(backgroundLevels({ ...PAGE.background, pattern: 'blank' }, 1)).toEqual([])
  })
  it('major lines are emphasised (coverage of minor lines is weaker)', () => {
    const lv = [{ spacing: 20, alpha: 1 }]
    const major = patternCoverageLevels(2, 100, 7, lv, 1, 5) // x = 100 = 5th line
    const minor = patternCoverageLevels(2, 80, 7, lv, 1, 5)
    expect(major).toBeCloseTo(1)
    expect(minor).toBeCloseTo(0.55)
    expect(patternCoverageLevels(2, 80, 7, lv, 1, 0)).toBeCloseTo(1)
  })
  it('stale default pattern colours are replaced on dark pages', () => {
    const light = { ...PAGE.background, lineColor: '#d0d4da', color: '#ffffff' }
    const dark = { ...PAGE.background, lineColor: '#d0d4da', color: '#121212' }
    expect(patternColor(light)).toBe('#c9ced6')
    expect(patternColor(dark)).toBe('#3a3f45')
    expect(patternColor({ ...dark, lineColor: '#ff0000' })).toBe(adaptColor('#ff0000', '#121212'))
  })
})

// --- colours drawn on dark pages ----------------------------------------------------------

function recordingCtx() {
  const log: { prop: string; value: unknown }[] = []
  const target: Record<string, unknown> = {}
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop === 'log') return log
      if (prop in t) return t[prop]
      return () => (prop === 'measureText' ? { width: 10 } : undefined)
    },
    set(t, prop: string, v) {
      t[prop] = v
      if (prop === 'fillStyle' || prop === 'strokeStyle') log.push({ prop, value: v })
      return true
    },
  })
  return ctx as unknown as CanvasRenderingContext2D & { log: typeof log }
}

const canvasWith = (ctx: unknown) => ({
  width: 300, height: 200, clientWidth: 300, clientHeight: 200, style: {}, getContext: () => ctx,
  addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLCanvasElement

function rgbaOf(hex: string, a = 1): string {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16)
  return `rgba(${n(1)},${n(3)},${n(5)},${a})`
}

describe('canvas-aware colours', () => {
  const dark = { ...PAGE, background: { ...PAGE.background, color: '#121212', pattern: 'blank' as const } }
  const light = { ...PAGE, background: { ...PAGE.background, color: '#ffffff', pattern: 'blank' as const } }
  const objs = (): CanvasObject[] => [
    ink('i', [[0, 0], [20, 10], [40, 0]], { style: { tool: 'pen', color: '#1e1e1e', width: 4, opacity: 1, pressureSensitive: false } }),
    shape('s', 'rectangle', 80, 50, {}, { strokeColor: '#1e1e1e', fillColor: '#a5d8ff', roughness: 0, fillStyle: 'solid' }),
    arrow('a', { x: 0, y: 0 }, { x: 100, y: 0 }, { style: { strokeColor: '#1e1e1e', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1 } }),
    text('t', 'hi', { color: '#1e1e1e' }),
  ]

  function paint(page: typeof dark) {
    const ctx = recordingCtx()
    const r = new Canvas2DRenderer(canvasWith(ctx))
    r.render(scene(objs(), { page }), { x: 0, y: 0, zoom: 1 })
    return ctx.log.map((l) => String(l.value))
  }

  it('draws adapted colours on a dark page and raw colours on a light page', () => {
    const onDark = paint(dark)
    const onLight = paint(light)
    const adaptedInk = adaptColor('#1e1e1e', '#121212')
    expect(adaptedInk).not.toBe('#1e1e1e')
    expect(onDark).toContain(rgbaOf(adaptedInk))
    expect(onDark).not.toContain(rgbaOf('#1e1e1e'))
    expect(onDark).toContain(rgbaOf(adaptColor('#a5d8ff', '#121212')))
    expect(onDark).toContain(adaptedInk) // text fillStyle passes the adapted hex
    expect(onLight).toContain(rgbaOf('#1e1e1e'))
    expect(onLight).toContain(rgbaOf('#a5d8ff'))
  })

  it('live ink layer adapts the stroke colour to the page background', () => {
    const ctx = recordingCtx()
    const live = createLiveInkLayer(canvasWith(ctx))
    live.setBackground!('#121212')
    live.begin({ tool: 'pen', color: '#1e1e1e', width: 3, opacity: 1, pressureSensitive: false })
    live.append([{ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, t: 0 }, { x: 10, y: 10, pressure: 0.5, tiltX: 0, tiltY: 0, t: 5 }], { x: 0, y: 0, zoom: 1 })
    expect(ctx.log.map((l) => l.value)).toContain(adaptColor('#1e1e1e', '#121212'))
    expect(ctx.log.map((l) => l.value)).not.toContain('#1e1e1e')
  })
})

describe('ArrowObject helpers', () => {
  it('unused import guard', () => {
    const a: ArrowObject = arrow('x', { x: 0, y: 0 }, { x: 1, y: 1 })
    expect(a.type).toBe('arrow')
  })
})
