import { describe, expect, it } from 'vitest'
import { recognizeShape } from '../src/shape'
import { makeStroke, polyline } from './helpers'
import { ellipseLoop, generateScribbles, generateShapeSamples, generateSparseShapeSamples } from './synth'

describe('recognizeShape', () => {
  it('reaches >= 90% accuracy on noisy synthetic shapes', () => {
    const samples = [...generateShapeSamples(1), ...generateShapeSamples(2), ...generateShapeSamples(3)]
    const wrong: string[] = []
    const perKind: Record<string, { ok: number; n: number }> = {}
    for (const s of samples) {
      const m = recognizeShape(s.strokes)
      const kind = s.label.replace(/\d+$/, '').replace(/_$/, '')
      perKind[kind] ??= { ok: 0, n: 0 }
      perKind[kind].n++
      if (m && m.shape === s.expect) perKind[kind].ok++
      else wrong.push(`${s.label}: expected ${s.expect}, got ${m?.shape ?? 'null'} (${m?.confidence.toFixed(2)})`)
    }
    if (wrong.length > 0.1 * samples.length) console.log(JSON.stringify(perKind), '\n' + wrong.join('\n'))
    const ok = samples.length - wrong.length
    expect(ok / samples.length).toBeGreaterThanOrEqual(0.9)
  })

  it('reaches >= 95% accuracy on sparsely sampled shapes (mouse input, 16-36 points)', () => {
    const samples = [1, 2].flatMap((seed) => generateSparseShapeSamples(seed, 20))
    const wrong = samples.filter((s) => recognizeShape(s.strokes)?.shape !== s.expect).map((s) => s.label)
    expect(wrong.length / samples.length, wrong.join(',')).toBeLessThanOrEqual(0.05)
  }, 30_000)

  it('classifies a rectangle with only a few points per side as a rectangle', () => {
    const side = (a: [number, number], b: [number, number], n: number) =>
      Array.from({ length: n }, (_, i) => ({ x: a[0] + ((b[0] - a[0]) * i) / n, y: a[1] + ((b[1] - a[1]) * i) / n }))
    const pts = [
      ...side([100, 100], [300, 100], 4), ...side([300, 100], [300, 220], 3),
      ...side([300, 220], [100, 220], 4), ...side([100, 220], [100, 100], 3), { x: 100, y: 104 },
    ]
    const m = recognizeShape([makeStroke(pts)])!
    expect(m.shape).toBe('rectangle')
    expect(m.confidence).toBeGreaterThan(0.75)
  })

  it('rejects text-like scribbles', () => {
    let accepted = 0
    const all = generateScribbles(7, 40)
    for (const strokes of all) if (recognizeShape(strokes, {})) accepted++
    expect(accepted).toBeLessThanOrEqual(0)
  })

  it('still rejects scribbles when they are sparsely sampled', () => {
    let accepted = 0
    for (const strokes of generateScribbles(11, 40)) {
      const sparse = strokes.map((st) => {
        const keep: number[] = []
        for (let i = 0; i + 5 < st.points.length; i += 6 * 5) keep.push(...st.points.slice(i, i + 6))
        return { ...st, points: keep }
      })
      if (recognizeShape(sparse)) accepted++
    }
    expect(accepted).toBe(0)
  })
})

describe('recognizeShape geometry', () => {
  it('reports box, rotation and confidence for a clean rectangle', () => {
    const s = makeStroke(polyline([{ x: 100, y: 50 }, { x: 300, y: 50 }, { x: 300, y: 170 }, { x: 100, y: 170 }, { x: 100, y: 52 }], false))
    const m = recognizeShape([s])!
    expect(m.shape).toBe('rectangle')
    expect(m.confidence).toBeGreaterThan(0.85)
    expect(m.rotation).toBe(0)
    expect(m.bounds.x).toBeCloseTo(100, 0)
    expect(m.bounds.width).toBeCloseTo(200, 0)
    expect(m.bounds.height).toBeCloseTo(120, 0)
  })

  it('recognizes a rectangle rotated 20 degrees with its rotation', () => {
    const a = (20 * Math.PI) / 180
    const c = [[0, 0], [200, 0], [200, 100], [0, 100], [0, 2]].map(([x, y]) => ({ x: 300 + x * Math.cos(a) - y * Math.sin(a), y: 200 + x * Math.sin(a) + y * Math.cos(a) }))
    const m = recognizeShape([makeStroke(polyline(c, false))])!
    expect(m.shape).toBe('rectangle')
    expect(m.rotation).toBeCloseTo(a, 1)
    expect(Math.max(m.bounds.width, m.bounds.height)).toBeCloseTo(200, -1)
  })

  it('reports a circle as an ellipse with equal sides', () => {
    const m = recognizeShape([makeStroke(ellipseLoop(120, 120).concat([{ x: 120, y: 60 }]).map((p) => ({ x: p.x + 40, y: p.y + 40 })))])!
    expect(m.shape).toBe('ellipse')
    expect(m.bounds.width).toBeCloseTo(m.bounds.height, 0)
  })

  it('keeps line/arrow direction (start -> end/tip)', () => {
    const line = recognizeShape([makeStroke(polyline([{ x: 300, y: 100 }, { x: 60, y: 40 }], false))])!
    expect(line.shape).toBe('line')
    expect(line.points![0]).toMatchObject({ x: 300, y: 100 })
    expect(line.points![1]).toMatchObject({ x: 60, y: 40 })

    const shaft = polyline([{ x: 0, y: 0 }, { x: 200, y: 0 }], false)
    const head = polyline([{ x: 175, y: -14 }, { x: 200, y: 0 }, { x: 175, y: 14 }], false, 3)
    const leftward = (p: { x: number; y: number }) => ({ x: 400 - p.x, y: p.y + 100 })
    const m = recognizeShape([makeStroke(shaft.map(leftward), { startedAt: 0 }), makeStroke(head.map(leftward), { startedAt: 800 })])!
    expect(m.shape).toBe('arrow')
    expect(m.points![0].x).toBeCloseTo(400, 0)
    expect(m.points![1].x).toBeCloseTo(200, 0)
  })

  it('applies the stroke transform', () => {
    const s = makeStroke(polyline([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 2 }], false), {
      transform: { x: 500, y: 300 },
    })
    const m = recognizeShape([s])!
    expect(m.bounds.x).toBeCloseTo(500, 0)
    expect(m.bounds.y).toBeCloseTo(300, 0)
  })

  it('ignores tiny ink, dots and open V/U shapes', () => {
    expect(recognizeShape([makeStroke(polyline([{ x: 0, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }, { x: 0, y: 1 }], false, 1))])).toBeNull()
    expect(recognizeShape([makeStroke(polyline([{ x: 0, y: 0 }, { x: 60, y: 120 }, { x: 120, y: 0 }], false))])).toBeNull()
    expect(recognizeShape([])).toBeNull()
  })
})
