import { describe, expect, it } from 'vitest'
import { NotebookDocument, createPage } from '@folio/document'
import { cameraForRect, clampCameraToPage, screenToWorld, worldToScreen, zoomCameraAt } from '../src'
import { setup } from './helpers'

describe('camera math', () => {
  it('screen/world round trip', () => {
    const cam = { x: 120, y: -40, zoom: 2.5 }
    const w = screenToWorld(cam, { x: 300, y: 200 })
    expect(w).toEqual({ x: 240, y: 40 })
    expect(worldToScreen(cam, w)).toEqual({ x: 300, y: 200 })
  })

  it('zoomAt keeps the world point under the cursor fixed and clamps', () => {
    const cam = { x: 10, y: 20, zoom: 1 }
    const s = { x: 400, y: 300 }
    const before = screenToWorld(cam, s)
    const next = zoomCameraAt(cam, s, 2)
    expect(next.zoom).toBe(2)
    const after = screenToWorld(next, s)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(zoomCameraAt(cam, s, 1e6).zoom).toBe(20)
    expect(zoomCameraAt(cam, s, 1e-9).zoom).toBe(0.05)
  })

  it('cameraForRect centers the rect', () => {
    const c = cameraForRect({ x: 100, y: 100, width: 200, height: 100 }, 800, 600, 0)
    expect(c.zoom).toBe(4)
    expect(c.x + 800 / c.zoom / 2).toBeCloseTo(200)
    expect(c.y + 600 / c.zoom / 2).toBeCloseTo(150)
  })

  it('clamps fixed-page panning loosely', () => {
    const c = clampCameraToPage({ x: 99999, y: -99999, zoom: 1 }, { width: 800, height: 1000 }, 500, 500)
    expect(c.x).toBeLessThan(800)
    expect(c.x).toBeGreaterThan(0)
    expect(c.y).toBeLessThan(0)
    expect(c.y).toBeGreaterThan(-500)
  })
})

describe('Editor camera', () => {
  it('panBy / zoomAt / events', () => {
    const h = setup()
    const seen: number[] = []
    h.editor.on('camera', (c) => seen.push(c.zoom))
    h.editor.panBy(100, 50)
    expect(h.editor.camera).toMatchObject({ x: -100, y: -50 })
    h.editor.zoomAt({ x: 0, y: 0 }, 2)
    expect(h.editor.camera.zoom).toBe(2)
    expect(seen.length).toBe(2)
    expect(h.editor.screenToWorld({ x: 200, y: 100 })).toEqual({ x: 0, y: 0 })
  })

  it('starts with fixed pages fitted to width and zoomToRect works', () => {
    const doc = NotebookDocument.create({ title: 'x' })
    const page = createPage({ kind: 'fixed', format: 'A4', order: 2 })
    doc.apply([{ type: 'addPage', page }])
    const h = setup({ document: doc, pageId: doc.pages()[0].id, size: [800, 600] })
    const ed = h.editor
    ed.setPage(page.id)
    expect(ed.camera.zoom).toBeCloseTo((800 - 32) / 794, 3)
    ed.zoomToRect({ x: 0, y: 0, width: 100, height: 100 }, 0)
    expect(ed.camera.zoom).toBeCloseTo(6)
  })
})
