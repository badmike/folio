import { rectIntersects, worldBounds, type ArrowObject, type ShapeObject } from '@folio/document'
import { describe, expect, it } from 'vitest'
import { createToolRunner } from '../src/ai/tools'
import { LAYOUTS } from '../src/ai/tools/layout'
import { call, fakeHost, notebook } from './ai-host'

const nodes = ['Idea', 'Research the problem space', 'Prototype', 'Test', 'Feedback', 'Ship it', 'Docs', 'Iterate']
  .map((label, i) => ({ key: `n${i}`, label }))
const edges = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [4, 2], [3, 5], [5, 6], [1, 7]]
  .map(([a, b]) => ({ from: `n${a}`, to: `n${b}`, label: a === 4 ? 'loop back' : undefined }))

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
