import { beforeAll, describe, expect, it } from 'vitest'
import type { ShapeObject } from '@folio/document'
import { resolveArrowEndpoints } from '../src/arrows'
import { counterOutline, counterTip, noteBox, noteTail } from '../src/callouts'
import { hitTestObject, objectIntersectsLasso, objectIntersectsRect, pointInPolygon } from '../src/hit'
import { objectWorldBounds, localBounds } from '../src/bounds'
import { layoutText, measureText, FONT_FAMILIES } from '../src/text'
import { drawTextLayout, type Ctx2D } from '../src/textdraw'
import { arrow, image, ink, scene, shape, text, useFakeMeasure } from './helpers'
import { patternCoverage, patternFade, patternKind } from '../src/background'
import { buildOverlay, selectionHandles, HANDLE_SIZE } from '../src/overlay'

beforeAll(useFakeMeasure)

const none = () => undefined

describe('hitTestObject', () => {
  it('ink: distance to polyline within width/2 + tolerance', () => {
    const s = ink('i', [[0, 0], [100, 0]], { style: { tool: 'pen', color: '#000', width: 6, opacity: 1, pressureSensitive: false } })
    expect(hitTestObject(s, { x: 50, y: 2 }, 0, none)).toBe(true)
    expect(hitTestObject(s, { x: 50, y: 5 }, 0, none)).toBe(false)
    expect(hitTestObject(s, { x: 50, y: 5 }, 3, none)).toBe(true)
    expect(hitTestObject(s, { x: 150, y: 0 }, 3, none)).toBe(false)
  })

  it('ink respects transform (scale, translate, rotate)', () => {
    const s = ink('i', [[0, 0], [100, 0]], {
      transform: { x: 10, y: 20, rotation: Math.PI / 2, scaleX: 1, scaleY: 1 },
    })
    // line now runs vertically from (10,20) to (10,120)
    expect(hitTestObject(s, { x: 10, y: 70 }, 0, none)).toBe(true)
    expect(hitTestObject(s, { x: 60, y: 20 }, 0, none)).toBe(false)
  })

  it('shape: outline hit, interior only when filled or labelled', () => {
    const r = shape('r', 'rectangle', 100, 60)
    expect(hitTestObject(r, { x: 0, y: 30 }, 2, none)).toBe(true)
    expect(hitTestObject(r, { x: 50, y: 30 }, 2, none)).toBe(false)
    const filled = shape('r', 'rectangle', 100, 60, {}, { fillColor: '#eee' })
    expect(hitTestObject(filled, { x: 50, y: 30 }, 0, none)).toBe(true)
    const labelled = shape('r', 'ellipse', 100, 60, { label: 'x' })
    expect(hitTestObject(labelled, { x: 50, y: 30 }, 0, none)).toBe(true)
    expect(hitTestObject(labelled, { x: 2, y: 2 }, 0, none)).toBe(false) // outside ellipse
    const line = shape('l', 'line', 100, 0)
    expect(hitTestObject(line, { x: 50, y: 1 }, 1, none)).toBe(true)
  })

  it('text and image: box', () => {
    const t = text('t', 'hello') // 5 chars * 10 = 50 wide, 26 high
    expect(measureText(t).width).toBe(50)
    expect(hitTestObject(t, { x: 40, y: 10 }, 0, none)).toBe(true)
    expect(hitTestObject(t, { x: 60, y: 10 }, 0, none)).toBe(false)
    const img = image('m', 40, 30)
    expect(hitTestObject(img, { x: 20, y: 15 }, 0, none)).toBe(true)
    expect(hitTestObject(img, { x: 50, y: 15 }, 0, none)).toBe(false)
  })

  it('arrow: segment distance, resolved through bindings', () => {
    const target = shape('t', 'rectangle', 100, 100, { transform: { x: 200, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } })
    const a = arrow('a', { x: 0, y: 50 }, { x: 0, y: 0 }, { endBinding: { objectId: 't' } })
    const sc = scene([target, a])
    // end resolves to the left edge of the target (200,50) so the shaft runs 0..200 along y=50
    expect(hitTestObject(a, { x: 100, y: 51 }, 0, sc.resolve)).toBe(true)
    expect(hitTestObject(a, { x: 100, y: 20 }, 0, sc.resolve)).toBe(false)
  })
})

describe('resolveArrowEndpoints', () => {
  const rect = shape('r', 'rectangle', 100, 60, { transform: { x: 100, y: 100, rotation: 0, scaleX: 1, scaleY: 1 } })
  const rect2 = shape('r2', 'rectangle', 100, 60, { transform: { x: 400, y: 100, rotation: 0, scaleX: 1, scaleY: 1 } })

  it('unbound arrows use their own endpoints', () => {
    const a = arrow('a', { x: 1, y: 2 }, { x: 3, y: 4 })
    expect(resolveArrowEndpoints(a, none)).toEqual({ start: { x: 1, y: 2 }, end: { x: 3, y: 4 } })
  })

  it('bound ends attach to the edge facing the other end', () => {
    const a = arrow('a', { x: 0, y: 0 }, { x: 0, y: 0 }, { startBinding: { objectId: 'r' }, endBinding: { objectId: 'r2' } })
    const sc = scene([rect, rect2, a])
    const { start, end } = resolveArrowEndpoints(a, sc.resolve)
    expect(start.x).toBeCloseTo(200)
    expect(start.y).toBeCloseTo(130)
    expect(end.x).toBeCloseTo(400)
    expect(end.y).toBeCloseTo(130)
  })

  it('one bound end aims at the free point', () => {
    const a = arrow('a', { x: 0, y: 0 }, { x: 150, y: 400 }, { startBinding: { objectId: 'r' } })
    const sc = scene([rect, a])
    const { start, end } = resolveArrowEndpoints(a, sc.resolve)
    expect(start.y).toBeCloseTo(160) // bottom edge
    expect(start.x).toBeGreaterThan(140)
    expect(end).toEqual({ x: 150, y: 400 })
  })

  it('ellipses use their curved outline; missing targets fall back', () => {
    const ell = shape('e', 'ellipse', 100, 100, { transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } })
    const a = arrow('a', { x: 0, y: 0 }, { x: 300, y: 50 }, { startBinding: { objectId: 'e' } })
    const { start } = resolveArrowEndpoints(a, scene([ell, a]).resolve)
    expect(start.x).toBeCloseTo(100, 0)
    const b = arrow('b', { x: 5, y: 6 }, { x: 7, y: 8 }, { startBinding: { objectId: 'gone' } })
    expect(resolveArrowEndpoints(b, none).start).toEqual({ x: 5, y: 6 })
  })

  it('respects target rotation/scale and explicit anchors', () => {
    const r = shape('r', 'rectangle', 100, 50, { transform: { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 2 } })
    const a = arrow('a', { x: 0, y: 0 }, { x: 500, y: 50 }, { startBinding: { objectId: 'r', anchor: { x: 0.5, y: 0.5 } } })
    const { start } = resolveArrowEndpoints(a, scene([r, a]).resolve)
    expect(start.x).toBeCloseTo(200) // right edge at 2× scale
    expect(start.y).toBeCloseTo(50, 0)
  })
})

describe('rect / lasso intersection', () => {
  const box = shape('b', 'rectangle', 100, 100)
  it('unfilled shape: only crossing the outline counts; rect inside does not', () => {
    expect(objectIntersectsRect(box, { x: -10, y: 40, width: 20, height: 20 }, none)).toBe(true)
    expect(objectIntersectsRect(box, { x: 40, y: 40, width: 10, height: 10 }, none)).toBe(false)
    expect(objectIntersectsRect(box, { x: 300, y: 300, width: 10, height: 10 }, none)).toBe(false)
  })
  it('filled shape: rect fully inside counts', () => {
    const f = shape('b', 'rectangle', 100, 100, {}, { fillColor: '#fff' })
    expect(objectIntersectsRect(f, { x: 40, y: 40, width: 10, height: 10 }, none)).toBe(true)
  })
  it('ink segments, arrows and text', () => {
    const s = ink('i', [[0, 0], [100, 100]])
    expect(objectIntersectsRect(s, { x: 45, y: 45, width: 10, height: 10 }, none)).toBe(true)
    expect(objectIntersectsRect(s, { x: 80, y: 0, width: 10, height: 10 }, none)).toBe(false)
    const a = arrow('a', { x: 0, y: 0 }, { x: 100, y: 0 })
    expect(objectIntersectsRect(a, { x: 40, y: -5, width: 10, height: 10 }, none)).toBe(true)
    const t = text('t', 'hello')
    expect(objectIntersectsRect(t, { x: 10, y: 5, width: 5, height: 5 }, none)).toBe(true)
  })
  it('lasso requires most points inside', () => {
    const s = ink('i', Array.from({ length: 11 }, (_, i) => [i * 10, 0] as [number, number]))
    const around = [{ x: -5, y: -5 }, { x: 105, y: -5 }, { x: 105, y: 5 }, { x: -5, y: 5 }]
    expect(objectIntersectsLasso(s, around, none)).toBe(true)
    const partial = [{ x: -5, y: -5 }, { x: 25, y: -5 }, { x: 25, y: 5 }, { x: -5, y: 5 }]
    expect(objectIntersectsLasso(s, partial, none)).toBe(false)
    expect(objectIntersectsLasso(s, around.slice(0, 2), none)).toBe(false)
    expect(objectIntersectsLasso(shape('b', 'rectangle', 50, 50), around.map((p) => ({ x: p.x - 10, y: p.y - 10 + 0 })), none)).toBe(false)
  })
  it('pointInPolygon', () => {
    const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]
    expect(pointInPolygon({ x: 2, y: 2 }, tri)).toBe(true)
    expect(pointInPolygon({ x: 8, y: 8 }, tri)).toBe(false)
  })
})

describe('bounds & text layout', () => {
  it('world bounds include transform and stroke width', () => {
    const s = shape('s', 'rectangle', 100, 50, { transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 } })
    const b = objectWorldBounds(s, none)!
    expect(b.x).toBeLessThan(10)
    expect(b.width).toBeGreaterThan(100)
    expect(localBounds(text('t', 'ab'))).toEqual({ x: 0, y: 0, width: 20, height: 26 })
  })
  it('wraps words at width and honours newlines', () => {
    const l = layoutText({ text: 'aaa bbb ccc\nd', fontSize: 20, fontFamily: 'sans', width: 70 })
    expect(l.lines).toEqual(['aaa bbb', 'ccc', 'd'])
    expect(l.width).toBe(70)
    expect(l.height).toBeCloseTo(3 * 26)
  })
  it('draws each line on the alphabetic baseline of its line box, like CSS', () => {
    const l = layoutText({ text: 'ab\ncd', fontSize: 20, fontFamily: 'hand', width: 0 })
    const calls: [string, number, number][] = []
    const ctx = { textBaseline: '', fillText: (t: string, x: number, y: number) => calls.push([t, x, y]) }
    drawTextLayout(ctx as unknown as Ctx2D, l, '#000', 'left', 5, 10)
    expect(ctx.textBaseline).toBe('alphabetic')
    expect(calls).toEqual([['ab', 5, 10 + l.baseline], ['cd', 5, 10 + l.lineHeight + l.baseline]])
    expect(l.baseline).toBeGreaterThan(0)
    expect(l.baseline).toBeLessThan(l.lineHeight)
  })
  it('breaks over-long words', () => {
    const l = layoutText({ text: 'abcdefghij', fontSize: 20, fontFamily: 'mono', width: 50 })
    expect(l.lines.length).toBeGreaterThan(1)
    expect(l.lines.join('')).toBe('abcdefghij')
  })
  it('font families', () => {
    expect(FONT_FAMILIES.hand).toContain('Excalifont')
    expect(FONT_FAMILIES.mono).toContain('Fira Code')
  })
})

describe('background math', () => {
  it('grid lines hit at multiples of spacing', () => {
    const k = patternKind('grid')
    expect(patternCoverage(k, 64, 10, 32, 1)).toBeCloseTo(1)
    expect(patternCoverage(k, 48, 16, 32, 1)).toBe(0)
    expect(patternCoverage(patternKind('ruled'), 5, 64, 32, 1)).toBeCloseTo(1)
    expect(patternCoverage(patternKind('ruled'), 64, 16, 32, 1)).toBe(0)
    expect(patternCoverage(patternKind('blank'), 0, 0, 32, 1)).toBe(0)
  })
  it('dots only at lattice nodes', () => {
    const k = patternKind('dot')
    expect(patternCoverage(k, 32, 64, 32, 1)).toBeCloseTo(1)
    expect(patternCoverage(k, 48, 48, 32, 1)).toBe(0)
  })
  it('dots and lines keep their screen size at every zoom', () => {
    for (const zoom of [1, 1.5, 3, 8]) {
      // 2px on screen from a node: outside the dot, outside a grid line
      expect(patternCoverage(patternKind('dot'), 32 + 2 / zoom, 64, 32, zoom)).toBe(0)
      expect(patternCoverage(patternKind('grid'), 32 + 2 / zoom, 16, 32, zoom)).toBe(0)
      expect(patternCoverage(patternKind('dot'), 32 + 1 / zoom, 64, 32, zoom)).toBeCloseTo(0.75)
    }
  })
  it('fades when too dense', () => {
    expect(patternFade(32, 0.05)).toBe(0)
    expect(patternFade(32, 1)).toBe(1)
    expect(patternCoverage(2, 0, 0, 32, 0.05)).toBe(0)
  })
  it('handles negative coordinates', () => {
    expect(patternCoverage(2, -64, -3, 32, 1)).toBeCloseTo(1)
  })
})

describe('overlay', () => {
  it('handles are placed on the rotated bounds in screen px', () => {
    const hs = selectionHandles({ x: 0, y: 0, width: 100, height: 50 }, 0, { x: 0, y: 0, zoom: 2 })
    const byId = Object.fromEntries(hs.map((h) => [h.id, h.screen]))
    expect(byId.nw).toEqual({ x: 0, y: 0 })
    expect(byId.se).toEqual({ x: 200, y: 100 })
    expect(byId.rotate.x).toBeCloseTo(100)
    expect(byId.rotate.y).toBeLessThan(0)
    const rot = selectionHandles({ x: 0, y: 0, width: 100, height: 100 }, Math.PI / 2, { x: 0, y: 0, zoom: 1 })
    expect(rot.find((h) => h.id === 'nw')!.screen.x).toBeCloseTo(100)
  })
  it('handle size is screen-constant', () => {
    const mk = (zoom: number) => buildOverlay(scene([], {
      selection: { ids: ['a'], bounds: { x: 0, y: 0, width: 10, height: 10 }, showHandles: true },
    }), { x: 0, y: 0, zoom })
    const sizeOf = (polys: ReturnType<typeof mk>) => {
      const h = polys.find((p) => p.fill === '#ffffff' && p.points.length === 4)!
      return Math.max(...h.points.map((p) => p.x)) - Math.min(...h.points.map((p) => p.x))
    }
    expect(sizeOf(mk(1))).toBeCloseTo(HANDLE_SIZE)
    expect(sizeOf(mk(8))).toBeCloseTo(HANDLE_SIZE)
  })
  it('marquee, lasso, highlights and binding target produce primitives', () => {
    const t = shape('t', 'rectangle', 10, 10)
    const polys = buildOverlay(scene([t], {
      highlights: [{ x: 0, y: 0, width: 5, height: 5 }],
      selection: { ids: [], showHandles: false, marquee: { x: 0, y: 0, width: 5, height: 5 }, lasso: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 9 }], bindingTargetId: 't' },
    }), { x: 0, y: 0, zoom: 1 })
    expect(polys.length).toBe(4)
  })
})

describe('notes and counters', () => {
  it("a counter's pin tip points towards its tail and is part of the hit area", () => {
    const c = shape('c', 'counter', 40, 40, { label: '1', tail: { x: 20, y: 100 } }, { fillColor: '#e03131' })
    const pin = counterOutline(c)
    const tip = pin[pin.length - 1]
    expect(tip.x).toBeCloseTo(20)
    expect(tip.y).toBeCloseTo(20 + 20 * Math.SQRT2)
    expect(hitTestObject(c, { x: 20, y: 46 }, 0, none)).toBe(true)
    expect(hitTestObject(c, { x: 2, y: 46 }, 0, none)).toBe(false)
  })

  it('counter styles: the drop reaches further than the pin, a circle has no tip', () => {
    const c = (counterStyle: 'pin' | 'drop' | 'circle') => shape('c', 'counter', 40, 40, { label: '1', counterStyle, tail: { x: 20, y: 100 } }, { fillColor: '#e03131' })
    const lowest = (s: ShapeObject) => Math.max(...counterOutline(s).map((p) => p.y))
    expect(lowest(c('pin'))).toBeCloseTo(20 + 20 * Math.SQRT2)
    expect(lowest(c('drop'))).toBeCloseTo(20 + 20 * 2.1, 1)
    expect(lowest(c('circle'))).toBeCloseTo(40)
    expect(counterTip(c('circle'))).toBeUndefined()
  })

  it("a note's pointer reaches outside the box, is hit and grows the bounds; a point inside the box draws none", () => {
    const n = text('n', 'Note', { background: '#e03131', tail: { x: 200, y: 100 } })
    const box = noteBox(n)
    expect(noteTail(box, { x: box.x + 1, y: box.y + 1 })).toBeUndefined()
    expect(hitTestObject(n, { x: 195, y: 97 }, 1, none)).toBe(true)
    expect(hitTestObject(n, { x: 195, y: 40 }, 1, none)).toBe(false)
    // a pointer that barely leaves the box is drawn as an equilateral nub on the edge facing it
    // and stands square on that edge even when the point is off to the side
    const nub = noteTail(box, { x: box.x + box.width * 0.8, y: box.y + box.height + 2 })!
    const side = (a: { x: number; y: number }, c: { x: number; y: number }) => Math.hypot(a.x - c.x, a.y - c.y)
    expect(side(nub[0], nub[1])).toBeCloseTo(side(nub[0], nub[2]))
    expect(side(nub[1], nub[2])).toBeCloseTo(side(nub[0], nub[2]))
    expect(nub[0].y).toBeCloseTo(nub[2].y)
    expect(nub[1].x).toBeCloseTo((nub[0].x + nub[2].x) / 2)
    expect(nub[1].y).toBeGreaterThan(box.y + box.height)
    const b = objectWorldBounds(n, none)!
    expect(b.x + b.width).toBeGreaterThanOrEqual(200)
    expect(b.y + b.height).toBeGreaterThanOrEqual(100)
  })
})
