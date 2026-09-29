import { describe, expect, it } from 'vitest'
import type { Recognition } from '@folio/document'
import { AUTO_CLEANUP_MIN_CONFIDENCE, estimateFontSize, planCleanup } from '../src/cleanup'
import { RecognitionEngine } from '../src/engine'
import { makeStroke, polyline } from './helpers'
import { FakeRecognizer, letters, rectStroke } from './fixtures'
import { applyTransform } from '../src/geometry'

const langs = ['en']

async function recognize(strokes: ReturnType<typeof letters>) {
  return new RecognitionEngine({ handwriting: new FakeRecognizer(() => '- Buy milk') }).recognize(strokes, langs)
}

describe('planCleanup', () => {
  it('proposes a TextObject at the group top-left with ink colour and source ids', async () => {
    const strokes = letters('a', 40, 60, 5, 0).map((s) => ({ ...s, style: { ...s.style, color: '#ff0000' } }))
    const recs = await recognize(strokes)
    const plan = planCleanup(strokes, recs)
    expect(plan).toHaveLength(1)
    const p = plan[0]
    expect(p.kind).toBe('text')
    if (p.kind !== 'text') return
    expect(p.object).toMatchObject({
      type: 'text',
      text: '- Buy milk',
      fontFamily: 'hand',
      color: '#ff0000',
      semanticType: 'list-item',
      sourceStrokeIds: recs[0].strokeIds,
    })
    expect(p.object.transform).toEqual({ x: recs[0].bounds.x, y: recs[0].bounds.y, rotation: 0, scaleX: 1, scaleY: 1 })
    expect(p.object.fontSize).toBe(estimateFontSize(recs[0].bounds.height))
    // editor-assigned fields are absent
    for (const k of ['id', 'z', 'createdAt', 'updatedAt']) expect(k in p.object).toBe(false)
  })

  it('honours minConfidence (manual 0.6 default, auto 0.85)', () => {
    const strokes = letters('a', 0, 0, 4, 0)
    const base: Recognition = {
      id: 'r1', kind: 'text', strokeIds: strokes.map((s) => s.id), bounds: { x: 0, y: 0, width: 50, height: 24 },
      text: 'hi', confidence: 0.7, recognizer: 'x', createdAt: 0,
    }
    expect(planCleanup(strokes, [base])).toHaveLength(1)
    expect(planCleanup(strokes, [base], { minConfidence: AUTO_CLEANUP_MIN_CONFIDENCE })).toHaveLength(0)
    expect(planCleanup(strokes, [{ ...base, confidence: 0.5 }])).toHaveLength(0)
    expect(planCleanup(strokes, [{ ...base, text: '  ' }])).toHaveLength(0)
    expect(planCleanup([], [base])).toHaveLength(0) // missing strokes
  })

  it('proposes a rough-styled ShapeObject preserving centre and size', async () => {
    const r = rectStroke('r', 300, 200, 160, 100)
    const recs = await new RecognitionEngine().recognize([r], langs)
    expect(recs[0].shape).toBe('rectangle')
    const plan = planCleanup([r], recs)
    expect(plan).toHaveLength(1)
    const p = plan[0]
    if (p.kind !== 'shape') throw new Error('expected shape')
    expect(p.object.kind).toBe('rectangle')
    expect(p.object.width).toBeCloseTo(160, -1)
    expect(p.object.height).toBeCloseTo(100, -1)
    expect(p.object.style.roughness).toBe(1)
    expect(p.object.style.strokeColor).toBe('#1e1e1e')
    expect(p.object.style.seed).toBeGreaterThan(0)
    expect(p.object.sourceStrokeIds).toEqual(['r'])
    // world centre of the local box equals the ink centre
    const c = applyTransform(p.object.transform, p.object.width / 2, p.object.height / 2)
    expect(c.x).toBeCloseTo(380, 0)
    expect(c.y).toBeCloseTo(250, 0)
  })

  it('keeps the centre for rotated shapes', async () => {
    const a = Math.PI / 6
    const corners = [[0, 0], [200, 0], [200, 100], [0, 100]].map(([x, y]) => ({
      x: 400 + x * Math.cos(a) - y * Math.sin(a),
      y: 300 + x * Math.sin(a) + y * Math.cos(a),
    }))
    const s = makeStroke(polyline([...corners, corners[0]], false, 3), { id: 'rot' })
    const recs = await new RecognitionEngine().recognize([s], langs)
    const p = planCleanup([s], recs)[0]
    if (!p || p.kind !== 'shape') throw new Error('expected shape')
    expect(p.object.transform.rotation).toBeCloseTo(a, 1)
    const centre = applyTransform(p.object.transform, p.object.width / 2, p.object.height / 2)
    const expectC = applyTransform({ x: 400, y: 300, rotation: a, scaleX: 1, scaleY: 1 }, 100, 50)
    expect(centre.x).toBeCloseTo(expectC.x, 0)
    expect(centre.y).toBeCloseTo(expectC.y, 0)
  })

  it('proposes an ArrowObject with start/end in world space', async () => {
    const shaft = makeStroke(polyline([{ x: 100, y: 100 }, { x: 300, y: 140 }], false), { id: 'sh', startedAt: 0 })
    const dx = 200
    const dy = 40
    const L = Math.hypot(dx, dy)
    const ux = dx / L
    const uy = dy / L
    const tip = { x: 300, y: 140 }
    const leg = (s: number) => ({ x: tip.x - ux * 25 - s * uy * 12, y: tip.y - uy * 25 + s * ux * 12 })
    const head = makeStroke(polyline([leg(1), tip, leg(-1)], false, 3), { id: 'hd', startedAt: 500 })
    const recs = await new RecognitionEngine().recognize([shaft, head], langs)
    expect(recs).toHaveLength(1)
    expect(recs[0].shape).toBe('arrow')
    const p = planCleanup([shaft, head], recs)[0]
    if (p.kind !== 'arrow') throw new Error('expected arrow')
    expect(p.object.start.x).toBeCloseTo(100, 0)
    expect(p.object.end.x).toBeCloseTo(300, 0)
    expect(p.object.end.y).toBeCloseTo(140, 0)
    expect(p.object.endHead).toBe('arrow')
    expect(p.object.startHead).toBe('none')
    expect(p.sourceStrokeIds).toEqual(['sh', 'hd'])
  })

  it('proposes a line as a horizontal shape rotated about its start', async () => {
    const s = makeStroke(polyline([{ x: 50, y: 50 }, { x: 50, y: 250 }], false), { id: 'l' })
    const recs = await new RecognitionEngine().recognize([s], langs)
    const p = planCleanup([s], recs)[0]
    if (!p || p.kind !== 'shape') throw new Error('expected line shape')
    expect(p.object.kind).toBe('line')
    expect(p.object.width).toBeCloseTo(200, 0)
    expect(p.object.height).toBe(0)
    expect(p.object.transform.rotation).toBeCloseTo(Math.PI / 2, 2)
    const end = applyTransform(p.object.transform, p.object.width, 0)
    expect(end.x).toBeCloseTo(50, 0)
    expect(end.y).toBeCloseTo(250, 0)
  })
})
