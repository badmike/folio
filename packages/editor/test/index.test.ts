import { describe, expect, it } from 'vitest'
import { SpatialIndex } from '../src'
import { addRaw, arrow, ink, setup, shape } from './helpers'

describe('SpatialIndex', () => {
  it('set/search/remove', () => {
    const i = new SpatialIndex()
    i.set('a', { x: 0, y: 0, width: 10, height: 10 })
    i.set('b', { x: 100, y: 100, width: 10, height: 10 })
    expect(i.search({ x: 5, y: 5, width: 1, height: 1 })).toEqual(['a'])
    i.set('a', { x: 200, y: 200, width: 5, height: 5 })
    expect(i.search({ x: 5, y: 5, width: 1, height: 1 })).toEqual([])
    i.set('b', null)
    expect(i.size).toBe(1)
  })
})

describe('Editor spatial index', () => {
  it('viewport query, incremental updates and superseded exclusion', () => {
    const h = setup({ size: [400, 300] })
    addRaw(h, [shape('near', 10, 10), shape('far', 5000, 5000), ink('s', [[0, 0], [5, 5]], 20, 20)])
    h.editor.renderNow()
    const ids = () => h.renderer.last.objects.map((o) => o.id).sort()
    expect(ids()).toEqual(['near', 's'])
    h.editor.setCamera({ x: 4900, y: 4900 })
    h.editor.renderNow()
    expect(ids()).toEqual(['far'])
    // move 'far' back into a different place, incrementally
    h.editor.updateObjects([{ id: 'far', patch: { transform: { x: -3000, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } } }])
    h.editor.renderNow()
    expect(ids()).toEqual([])
    expect(h.editor.queryRect({ x: -3010, y: -10, width: 200, height: 100 }).map((o) => o.id)).toEqual(['far'])
    // superseded strokes leave the index; delete removes
    h.editor.setCamera({ x: 0, y: 0 })
    h.editor.updateObjects([{ id: 's', patch: { supersededBy: 'near' } }])
    h.editor.renderNow()
    expect(ids()).toEqual(['near'])
    h.editor.deleteObjects(['near'])
    expect(h.editor.indexedIds()).toEqual(['far'])
    expect(h.renderer.invalidated.flat()).toContain('near')
  })

  it('arrows bound to moved objects get updated bounds', () => {
    const h = setup({ size: [400, 300] })
    addRaw(h, [shape('a', 0, 0, 100, 60), shape('b', 300, 0, 100, 60), arrow('ar', 100, 30, 300, 30, {
      startBinding: { objectId: 'a' }, endBinding: { objectId: 'b' },
    })])
    expect(h.editor.queryRect({ x: 5000, y: 0, width: 10, height: 10 })).toHaveLength(0)
    h.editor.updateObjects([{ id: 'b', patch: { transform: { x: 5000, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } } }])
    const hit = h.editor.queryRect({ x: 2500, y: 20, width: 5, height: 5 }).map((o) => o.id)
    expect(hit).toContain('ar')
  })
})
