import { describe, expect, it } from 'vitest'
import type { InkStroke } from '@folio/document'
import { estimateSkew } from '../src/raster'
import { strokeWorldPoints } from '../src/geometry'
import { planTidy } from '../src/tidy'
import { letters } from './fixtures'

const H = 24

/** Apply planned transforms to the strokes. */
function tidied(strokes: InkStroke[], ruleSpacing?: number): InkStroke[] {
  const moves = new Map(planTidy(strokes, { ruleSpacing }).map((m) => [m.id, m.transform]))
  return strokes.map((s) => ({ ...s, transform: moves.get(s.id) ?? s.transform }))
}

const bottom = (strokes: InkStroke[]) => Math.max(...strokes.flatMap(strokeWorldPoints).map((p) => p.y))
const left = (strokes: InkStroke[]) => Math.min(...strokes.flatMap(strokeWorldPoints).map((p) => p.x))

/** A line of letter strokes whose baseline falls by `slope` per unit x. */
function slanted(id: string, x: number, y: number, n: number, slope: number): InkStroke[] {
  return letters(id, x, y, n, 0, H).map((s, i) => ({ ...s, transform: { ...s.transform, y: s.transform.y + i * H * 0.55 * slope } }))
}

describe('planTidy', () => {
  it('rotates a slanted line level and keeps a straight one in place', () => {
    const line = slanted('a', 0, 0, 10, Math.tan((6 * Math.PI) / 180))
    expect(Math.abs(estimateSkew(line.map(strokeWorldPoints)))).toBeGreaterThan(0.08)
    const after = tidied(line)
    expect(Math.abs(estimateSkew(after.map(strokeWorldPoints)))).toBeLessThan(0.005)
    expect(planTidy(letters('b', 0, 0, 10, 0, H))).toEqual([])
  })

  it('evens out line spacing and margins in a paragraph but keeps indents', () => {
    const lines = [
      letters('a', 0, 0, 8, 0, H),
      letters('b', 6, 40, 8, 2000, H), // close and nudged right: snaps to the margin
      letters('c', 2, 92, 8, 4000, H), // far
      letters('d', 40, 130, 8, 6000, H), // indented
    ]
    const after = tidied(lines.flat())
    const byLine = lines.map((l) => after.filter((s) => l.some((o) => o.id === s.id)))
    const baselines = byLine.map(bottom)
    const gaps = baselines.slice(1).map((b, i) => b - baselines[i])
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 5)
    expect(left(byLine[1])).toBeCloseTo(left(byLine[0]), 5)
    expect(left(byLine[2])).toBeCloseTo(left(byLine[0]), 5)
    expect(left(byLine[3])).toBeCloseTo(40, 5)
  })

  it('puts baselines on the page rules', () => {
    const after = tidied([...letters('a', 0, 3, 8, 0, H), ...letters('b', 0, 37, 8, 2000, H)], 32)
    expect(bottom(after.filter((s) => s.id.startsWith('a')))).toBeCloseTo(32, 5)
    expect(bottom(after.filter((s) => s.id.startsWith('b')))).toBeCloseTo(64, 5)
  })
})
