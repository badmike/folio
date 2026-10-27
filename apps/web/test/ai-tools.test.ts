import {
  createId, createPage, defaultShapeStyle, encodeInkPoints, identityTransform, rectContains, worldBounds,
  type InkStroke, type ShapeObject, type TextObject,
} from '@folio/document'
import { describe, expect, it } from 'vitest'
import tools from '../../server/tools/folio-tools.json'
import { TOOL_NAMES } from '../src/ai/protocol'
import { contextBuilder, createToolRunner } from '../src/ai/tools'
import { VIEWPORT, call, fakeHost, notebook } from './ai-host'

describe('AI tools', () => {
  it('rejects invalid input with a message that names the field', async () => {
    const doc = notebook('Notes')
    const { host } = fakeHost([doc])
    const res = await createToolRunner(host).run(call('create_shapes', { shapes: [{ kind: 'hexagon', width: 80, height: 40 }] }), 't1')
    expect(res.isError).toBe(true)
    expect(res.output).toEqual({ error: expect.stringContaining('shapes[0].kind: expected one of rectangle, ellipse') })
    expect(doc.objects(doc.pages()[0].id)).toHaveLength(0)
  })

  it('creates Markdown text in the theme font in the viewport, with effects that undo it', async () => {
    const doc = notebook('Notes')
    const pageId = doc.pages()[0].id
    const { host, highlights } = fakeHost([doc])
    const res = await createToolRunner(host).run(call('create_text', { markdown: '# Cells\n\nThe basic unit of life.\n\n- nucleus\n- membrane' }), 't1')

    expect(res.isError).toBe(false)
    const texts = doc.objects(pageId).filter((o): o is TextObject => o.type === 'text')
    expect(texts.map((t) => [t.semanticType, t.fontFamily, t.text])).toEqual([
      ['heading', 'hand', 'Cells'],
      ['paragraph', 'hand', 'The basic unit of life.'],
      ['list-item', 'hand', '- nucleus\n- membrane'],
    ])
    for (const t of texts) expect(rectContains(VIEWPORT, worldBounds(t))).toBe(true)
    expect(highlights).toEqual([texts.map((t) => t.id)])

    const [effect] = res.effects
    expect(effect.ops).toHaveLength(1)
    doc.apply(effect.inverse)
    expect(doc.objects(pageId)).toHaveLength(0)
  })

  it('asks before writing to another notebook and remembers "allow for this thread"', async () => {
    const open = notebook('Open')
    const other = notebook('Other')
    const { host, approvals } = fakeHost([open, other], ['thread'])
    const runner = createToolRunner(host)
    const write = () => runner.run(call('create_text', { notebookId: other.id, markdown: 'Hi' }), 't1')

    expect((await write()).isError).toBe(false)
    expect((await write()).isError).toBe(false)
    expect(approvals).toEqual([{ kind: 'other_notebook', notebookId: other.id, summary: 'Edit the notebook "Other"' }])

    // a new thread asks again (and the fake denies)
    const denied = await createToolRunner(host).run(call('create_text', { notebookId: other.id, markdown: 'Hi' }), 't2')
    expect(denied.isError).toBe(true)
    expect(approvals).toHaveLength(2)
    expect(other.objects(other.pages()[0].id)).toHaveLength(2)
  })

  it('keeps the page when the user declines delete_page', async () => {
    const doc = notebook('Notes')
    const extra = createPage({ title: 'Eigenvectors', order: 2 })
    doc.apply([{ type: 'addPage', page: extra }])
    const { host, approvals } = fakeHost([doc], ['deny'])

    const res = await createToolRunner(host).run(call('delete_page', { pageId: extra.id }), 't1')

    expect(res.isError).toBe(true)
    expect(res.output).toEqual({ error: expect.stringContaining('declined') })
    expect(approvals).toEqual([{ kind: 'delete_page', notebookId: doc.id, summary: 'Delete page 2 "Eigenvectors"' }])
    expect(doc.page(extra.id)).toBeDefined()
  })

  it('outlines the page with ids, rounded bounds and recognized handwriting', async () => {
    const doc = notebook('Notes')
    const pageId = doc.pages()[0].id
    const shape: ShapeObject = {
      id: createId(), type: 'shape', kind: 'rectangle', transform: { ...identityTransform(), x: 100.4, y: 49.6 },
      z: 1, createdAt: 1, updatedAt: 1, width: 160, height: 80, style: defaultShapeStyle(), label: 'Start',
    }
    const ink: InkStroke = {
      id: createId(), type: 'ink', transform: identityTransform(), z: 2, createdAt: 1, updatedAt: 1,
      points: encodeInkPoints([0, 1, 2].map((i) => ({ x: 400 + i * 20, y: 300, pressure: 0.5, tiltX: 0, tiltY: 0, t: i }))),
      style: { tool: 'pen', color: '#1e1e1e', width: 2, opacity: 1, pressureSensitive: true }, startedAt: 1, pointerType: 'pen',
    }
    const rec = { id: createId(), kind: 'text' as const, strokeIds: [ink.id], bounds: { x: 399, y: 299, width: 42, height: 2 }, text: 'mitosis', confidence: 0.9, recognizer: 'test', createdAt: 1 }
    doc.apply([
      { type: 'addObjects', pageId, objects: [shape, ink] },
      { type: 'setRecognitions', pageId, recognitions: [rec] },
    ])
    const { host } = fakeHost([doc])

    const { outline } = await contextBuilder.environment(host)

    expect(outline).toContain(`id=${pageId}`)
    expect(outline).toContain(`${shape.id} rectangle "Start" [100,50 160x80]`)
    expect(outline).toContain(`${rec.id} handwriting "mitosis" [399,299 42x2] (1 stroke)`)
    expect(outline).not.toContain(`${ink.id} ink`)
  })

  it('declares exactly TOOL_NAMES, in order, in folio-tools.json', () => {
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES])
  })
})
