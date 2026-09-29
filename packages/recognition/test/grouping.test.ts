import { describe, expect, it } from 'vitest'
import { findShapeCandidates, groupStrokes, groupTextStrokes } from '../src/grouping'
import { makeStroke, polyline } from './helpers'

/** A "word": n letter-like strokes (small zig-zags) side by side. */
function word(id: string, x: number, y: number, letters: number, t0: number, H = 24) {
  const out = []
  for (let i = 0; i < letters; i++) {
    const lx = x + i * (H * 0.55)
    const pts = polyline(
      [{ x: lx, y: y + H }, { x: lx + H * 0.2, y }, { x: lx + H * 0.4, y: y + H }],
      false,
      3,
    )
    out.push(makeStroke(pts, { id: `${id}${i}`, startedAt: t0 + i * 250 }))
  }
  return out
}

function widthOf(letters: number, H = 24) {
  return letters * H * 0.55 + H * 0.4
}

describe('groupTextStrokes', () => {
  it('splits a line into words and lines into a block', () => {
    const H = 24
    const strokes = [
      ...word('a', 0, 0, 4, 0),
      ...word('b', widthOf(4) + H, 0, 3, 2000),
      ...word('c', widthOf(4) + widthOf(3) + 2 * H, 0, 5, 4000),
      ...word('d', 0, 44, 6, 8000),
      ...word('e', widthOf(6) + H, 44, 2, 10000),
    ]
    const g = groupTextStrokes(strokes)
    expect(g.lines).toHaveLength(2)
    expect(g.words.map((w) => w.strokeIds.length).sort()).toEqual([2, 3, 4, 5, 6])
    expect(g.blocks).toHaveLength(1)
    expect(g.blocks[0].strokeIds).toHaveLength(strokes.length)
    // lines are ordered top to bottom
    expect(g.lines[0].bounds.y).toBeLessThan(g.lines[1].bounds.y)
    expect(g.lines[0].strokeIds).toHaveLength(12)
  })

  it('keeps a late i-dot / t-bar with its word (time gap but spatial overlap)', () => {
    const w = word('w', 0, 0, 3, 0)
    const dot = makeStroke(polyline([{ x: 6, y: -8 }, { x: 8, y: -8 }], false, 1), { id: 'dot', startedAt: 9000 })
    const g = groupTextStrokes([...w, dot])
    expect(g.words).toHaveLength(1)
    expect(g.lines).toHaveLength(1)
    expect(g.words[0].strokeIds).toContain('dot')
  })

  it('separates distant blocks and distinct columns', () => {
    const strokes = [...word('a', 0, 0, 3, 0), ...word('b', 0, 300, 3, 1000), ...word('c', 900, 0, 3, 2000)]
    const g = groupTextStrokes(strokes)
    expect(g.lines).toHaveLength(3)
    expect(g.blocks).toHaveLength(0)
  })

  it('applies stroke transforms (world space)', () => {
    const a = word('a', 0, 0, 3, 0)
    const b = word('b', 0, 0, 3, 1000).map((s) => ({ ...s, transform: { ...s.transform, y: 300 } }))
    const g = groupTextStrokes([...a, ...b])
    expect(g.lines).toHaveLength(2)
    expect(g.lines[1].bounds.y).toBeGreaterThan(290)
  })

  it('is stable for empty input', () => {
    expect(groupStrokes([])).toEqual([])
  })
})

describe('shape candidates', () => {
  it('flags a large closed stroke amid text, leaves text alone', () => {
    const text = [...word('a', 0, 0, 4, 0), ...word('b', 0, 40, 4, 3000)]
    const rect = makeStroke(polyline([{ x: 200, y: 0 }, { x: 360, y: 0 }, { x: 360, y: 120 }, { x: 200, y: 120 }, { x: 200, y: 2 }], false), {
      id: 'rect',
      startedAt: 6000,
    })
    const groups = groupStrokes([...text, rect])
    const cands = groups.filter((g) => g.kind === 'shape-candidate')
    expect(cands).toHaveLength(1)
    expect(cands[0].strokeIds).toEqual(['rect'])
    expect(groups.filter((g) => g.kind === 'line')).toHaveLength(2)
  })

  it('clusters a shaft with a nearby head stroke into one candidate', () => {
    const shaft = makeStroke(polyline([{ x: 0, y: 0 }, { x: 200, y: 0 }], false), { id: 'shaft', startedAt: 0 })
    const head = makeStroke(polyline([{ x: 180, y: -14 }, { x: 200, y: 0 }, { x: 180, y: 14 }], false), { id: 'head', startedAt: 700 })
    const far = makeStroke(polyline([{ x: 0, y: 80 }, { x: 10, y: 90 }, { x: 20, y: 80 }], false), { id: 'far', startedAt: 800 })
    const { candidates, rest } = findShapeCandidates([shaft, head, far])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].map((s) => s.id)).toEqual(['shaft', 'head'])
    expect(rest.map((s) => s.id)).toEqual(['far'])
  })
})
