import { rectIntersects, worldBounds, type ArrowObject, type NotebookDocument, type ShapeObject } from '@folio/document'
import { arrowPath } from '@folio/renderer'
import { describe, expect, it } from 'vitest'
import { createToolRunner } from '../src/ai/tools'
import { LAYOUTS } from '../src/ai/tools/layout'
import { call, fakeHost, notebook } from './ai-host'

const nodes = ['Idea', 'Research the problem space', 'Prototype', 'Test', 'Feedback', 'Ship it', 'Docs', 'Iterate']
  .map((label, i) => ({ key: `n${i}`, label }))
const edges = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [4, 2], [3, 5], [5, 6], [1, 7]]
  .map(([a, b]) => ({ from: `n${a}`, to: `n${b}`, label: a === 4 ? 'loop back' : undefined }))

/** Node shapes each arrow's drawn path passes through, besides its own ends (sampled along the path). */
function crossings(doc: NotebookDocument, pageId: string): string[] {
  const resolve = (id: string) => doc.object(pageId, id)
  const shapes = doc.objects(pageId).filter((o): o is ShapeObject => o.type === 'shape')
  const out: string[] = []
  for (const a of doc.objects(pageId).filter((o): o is ArrowObject => o.type === 'arrow')) {
    const path = arrowPath(a, resolve)
    const points = path.flatMap((p, i) => (i ? [0.25, 0.5, 0.75, 1] : [1]).map((t) => {
      const q = path[Math.max(0, i - 1)]
      return { x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t }
    }))
    for (const s of shapes) {
      if (s.id === a.startBinding?.objectId || s.id === a.endBinding?.objectId) continue
      const b = worldBounds(s)
      if (points.some((p) => p.x > b.x && p.x < b.x + b.width && p.y > b.y && p.y < b.y + b.height)) out.push(`${a.label ?? a.id} through ${s.label}`)
    }
  }
  return out
}

describe('draw_diagram', () => {
  it.each(LAYOUTS)('lays out %s without overlaps and binds every arrow', async (layout) => {
    const doc = notebook('Diagrams')
    const pageId = doc.pages()[0].id
    const res = await createToolRunner(fakeHost([doc]).host).run(call('draw_diagram', { nodes, edges, layout }), 't1')
    expect(res.isError).toBe(false)

    const { nodes: ids } = res.output as { nodes: Record<string, string> }
    const shapes = nodes.map((n) => doc.object(pageId, ids[n.key]) as ShapeObject)
    // rectIntersects counts touching edges, so shrink by a hair
    const boxes = shapes.map((s) => {
      const b = worldBounds(s)
      return { x: b.x + 0.5, y: b.y + 0.5, width: b.width - 1, height: b.height - 1 }
    })
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(rectIntersects(boxes[i], boxes[j]), `${nodes[i].key} overlaps ${nodes[j].key}`).toBe(false)
    }

    const arrows = doc.objects(pageId).filter((o): o is ArrowObject => o.type === 'arrow')
    expect(arrows.map((a) => [a.startBinding?.objectId, a.endBinding?.objectId]))
      .toEqual(edges.map((e) => [ids[e.from], ids[e.to]]))
    expect(crossings(doc, pageId)).toEqual([])
  })

  it.each([
    ['layered', [['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'd'], ['d', 'a']]],
    ['grid', [['a', 'c'], ['a', 'g'], ['c', 'i']]],
  ] as const)('routes %s edges around the nodes they would pass through', async (layout, pairs) => {
    const doc = notebook('Diagrams')
    const pageId = doc.pages()[0].id
    const keys = [...'abcdefghi'].slice(0, layout === 'grid' ? 9 : 4)
    await createToolRunner(fakeHost([doc]).host).run(call('draw_diagram', {
      nodes: keys.map((k) => ({ key: k, label: k.toUpperCase() })), edges: pairs.map(([from, to]) => ({ from, to })), layout,
    }), 't1')
    expect(crossings(doc, pageId)).toEqual([])
  })

  it('bows the two arrows of a two-way edge apart, so they and their labels do not overlap', async () => {
    const doc = notebook('Diagrams')
    const pageId = doc.pages()[0].id
    const pair = [{ from: 'a', to: 'b', label: 'ask' }, { from: 'b', to: 'a', label: 'answer' }]
    await createToolRunner(fakeHost([doc]).host).run(call('draw_diagram', { nodes: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], edges: pair, layout: 'layered' }), 't1')
    const [there, back] = doc.objects(pageId).filter((o): o is ArrowObject => o.type === 'arrow')
    expect([there.arrowType, back.arrowType]).toEqual(['curved', 'curved'])
    const [p, q] = [there.waypoints![0], back.waypoints![0]]
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(50)
  })
})
