import { describe, expect, it } from 'vitest'
import { resolveTheme } from '@folio/document'
import { buildShapeGeometry } from '../src/geometry/rough'
import { castsShadow, shapeShadow } from '../src/shadow'
import { layoutText, withTypography } from '../src/text'
import { ROUGH, shape, text, useFakeMeasure } from './helpers'

const SKETCH = resolveTheme('sketchnote')

describe('themes in the renderer', () => {
  it("draws Sketchnote shapes bolder, as marker strokes, honouring each shape's fill style", () => {
    const s = shape('s', 'rectangle', 100, 60, {}, { fillColor: '#ffec99', fillStyle: 'solid' })
    const sketch = buildShapeGeometry(s, SKETCH)
    expect(sketch.strokeWidth).toBeCloseTo(2 * SKETCH.strokeScale)
    expect(sketch.fills.length).toBeGreaterThan(0)
    expect(sketch.hatch).toEqual([])
    // hachure stays hachure, drawn with the bold marker
    const hatched = buildShapeGeometry({ ...s, style: { ...s.style, fillStyle: 'hachure' } }, SKETCH)
    expect(hatched.fills).toEqual([])
    expect(hatched.hatchWidth).toBeGreaterThan(buildShapeGeometry({ ...s, style: { ...s.style, fillStyle: 'hachure' } }, ROUGH).hatchWidth)
    // marker strokes are filled outlines
    expect(sketch.strokes).toEqual([])
    expect(sketch.solids.length).toBeGreaterThan(0)
    expect(buildShapeGeometry(s, SKETCH)).toEqual(sketch)
  })

  it("wiggles with each shape's sloppiness and overdraws with the theme's setting", () => {
    const at = (roughness: number) => shape('s', 'rectangle', 200, 100, {}, { seed: 4, roughness })
    const reach = (theme: ReturnType<typeof resolveTheme>, roughness: number) => {
      const xs = buildShapeGeometry(at(roughness), theme).solids.flat().map((p) => p.x)
      return Math.max(...xs) - Math.min(...xs) - 200
    }
    // overdraw: the theme setting decides how far lines run past the corners
    expect(reach(resolveTheme('sketchnote', { hand: 'refined' }), 0)).toBeLessThan(reach(resolveTheme('sketchnote', { hand: 'sloppy' }), 0))
    // wiggle: the shape's sloppiness bends the edges, at the same overdraw
    const bend = (roughness: number) => {
      const ys = buildShapeGeometry(at(roughness), SKETCH).solids.flat().filter((p) => p.x > 60 && p.x < 140 && p.y < 50).map((p) => p.y)
      return Math.max(...ys.map(Math.abs))
    }
    expect(bend(0)).toBeLessThan(bend(2))
    // Blueprint: an architect's shape is ruled exactly
    const exact = buildShapeGeometry(at(0), resolveTheme('blueprint', { hand: 'refined' })).strokes.flat().map((p) => p.x)
    expect(Math.min(...exact)).toBeCloseTo(0)
    // Chalkboard retraces every edge when it overdraws
    const chalk = (hand: 'refined' | 'artist') => buildShapeGeometry(at(2), resolveTheme('chalkboard', { hand })).strokes.length
    expect(chalk('artist')).toBeGreaterThan(chalk('refined'))
  })

  it('paints fills in each theme\'s own way; a hatched shape casts only the outer shadow', () => {
    const filled = (fillStyle: 'solid' | 'hachure', o = {}) => shape('f', 'rectangle', 120, 80, {}, { fillColor: '#ffec99', fillStyle, ...o })
    // Whiteboard shades a solid fill with broad translucent marker strokes
    const marker = buildShapeGeometry(filled('solid'), resolveTheme('whiteboard'))
    expect(marker.fills).toEqual([])
    expect(marker.hatch.length).toBeGreaterThan(5)
    expect(marker.fillOpacity).toBeLessThan(1)
    // Blueprint's solid is a translucent wash, its hatching fine
    const blueprint = resolveTheme('blueprint')
    expect(buildShapeGeometry(filled('solid'), blueprint)).toMatchObject({ fillOpacity: 0.45 })
    expect(buildShapeGeometry(filled('hachure'), blueprint).hatchWidth).toBeLessThan(buildShapeGeometry(filled('hachure'), ROUGH).hatchWidth)
    // Chalk shades solids with a scribble
    expect(buildShapeGeometry(filled('solid', { roughness: 1 }), resolveTheme('chalkboard')).hatch.length).toBeGreaterThan(0)
    const hatched = filled('hachure')
    const sketch = SKETCH
    expect(shapeShadow(hatched, buildShapeGeometry(hatched, sketch), { x: 5, y: 5 }).fills.length).toBeGreaterThan(1)
  })

  it('prints comic hachure as halftone dots and paints watercolour as layered washes', () => {
    const hatched = shape('h', 'rectangle', 120, 80, {}, { fillColor: '#a5d8ff', fillStyle: 'hachure' })
    const comic = buildShapeGeometry(hatched, resolveTheme('comic'))
    expect(comic.fills.length).toBeGreaterThan(40)
    expect(comic.flat).toBe(false)
    // dots let the paper show, so the shadow is only the outer band
    expect(shapeShadow(hatched, comic, { x: 6, y: 6 }).fills.length).toBeLessThan(10)
    const washed = buildShapeGeometry({ ...hatched, style: { ...hatched.style, fillStyle: 'solid' } }, resolveTheme('watercolour'))
    expect(washed.fills).toHaveLength(3)
    expect(washed.hatch.length).toBeGreaterThan(0)
    expect(washed.fillOpacity).toBeLessThan(0.5)
    // the wash bleeds past the outline
    expect(Math.max(...washed.fills.flat().map((p) => p.x))).toBeGreaterThan(120)
  })

  it('casts shadows from closed shapes and notes only, as a silhouette or an outline echo', () => {
    expect(castsShadow(shape('r', 'rectangle', 10, 10), SKETCH)).toBe(true)
    expect(castsShadow(shape('l', 'line', 10, 10), SKETCH)).toBe(false)
    expect(castsShadow(text('n', 'hi', { background: '#ffec99' }), SKETCH)).toBe(true)
    expect(castsShadow(text('t', 'hi'), SKETCH)).toBe(false)
    expect(castsShadow(shape('r', 'rectangle', 10, 10), ROUGH)).toBe(false)
    // an unfilled shape's shadow only covers what lies outside the shape
    const open = shape('o', 'rectangle', 40, 30)
    const pieces = shapeShadow(open, buildShapeGeometry(open, SKETCH), { x: 5, y: 5 }).fills
    const area = pieces.reduce((a, p) => a + Math.abs(p.reduce((s, q, i) => s + q.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * q.y, 0)) / 2, 0)
    expect(area).toBeCloseTo(40 * 30 - 35 * 25)
  })

  it('lays out the base font in the theme font and capitals; picked fonts stay', () => {
    useFakeMeasure()
    const t = text('t', 'Hello', { fontFamily: 'hand' })
    const l = withTypography(SKETCH, () => layoutText(t))
    expect(l.lines).toEqual(['HELLO'])
    expect(l.font).toContain('Gochi Hand')
    expect(withTypography(SKETCH, () => layoutText({ ...t, fontFamily: 'mono' })).font).toContain('Fira Code')
    expect(layoutText(t).lines).toEqual(['Hello'])
  })
})
