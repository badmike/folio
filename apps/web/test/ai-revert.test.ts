import { createId, defaultShapeStyle, identityTransform, type ShapeObject } from '@folio/document'
import { describe, expect, it } from 'vitest'
import { createToolRunner, revertEffects } from '../src/ai/tools'
import { call, fakeHost, notebook } from './ai-host'

describe('revertEffects', () => {
  it('undoes the AI ops newest first but leaves objects the user changed since', async () => {
    const doc = notebook('Notes')
    const pageId = doc.pages()[0].id
    const mine: ShapeObject = {
      id: createId(), type: 'shape', kind: 'rectangle', transform: { ...identityTransform(), x: 600, y: 400 },
      z: 1, createdAt: 1, updatedAt: 1, width: 100, height: 60, style: defaultShapeStyle(),
    }
    doc.apply([{ type: 'addObjects', pageId, objects: [mine] }])
    const { host } = fakeHost([doc])
    const runner = createToolRunner(host)

    const created = await runner.run(call('create_shapes', { shapes: [{ kind: 'ellipse', width: 80, height: 80 }, { kind: 'diamond', width: 80, height: 80 }] }), 't1')
    const recolored = await runner.run(call('update_objects', { updates: [{ id: mine.id, style: { strokeColor: '#e03131' } }] }), 't1')
    const [touched, untouched] = (created.output as { ids: string[] }).ids
    // the user restyles one AI shape in the editor (which stamps updatedAt)
    doc.apply([{ type: 'updateObjects', pageId, patches: [{ id: touched, patch: { label: 'mine now', updatedAt: Date.now() + 1000 } }] }])

    const report = await revertEffects(host, [...recolored.effects, ...created.effects])

    expect(report).toEqual({ reverted: 2, skipped: [{ notebookId: doc.id, pageId, id: touched }] })
    expect(doc.object(pageId, touched)).toMatchObject({ label: 'mine now' })
    expect(doc.object(pageId, untouched)).toBeUndefined()
    expect(doc.object(pageId, mine.id)).toEqual(mine)
  })
})
