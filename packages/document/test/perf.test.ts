import { describe, expect, it } from 'vitest'
import { NotebookDocument } from '../src'
import { stroke } from './helpers'

describe('perf sanity', () => {
  it('5,000 strokes x 100 points: apply + snapshot + load', () => {
    const d = NotebookDocument.create({ title: 'big' }, { peerId: 7 })
    const P = d.pages()[0].id
    const strokes = Array.from({ length: 5000 }, (_, i) => stroke(i % 100, Math.floor(i / 100), 100))
    let t0 = performance.now()
    for (let i = 0; i < strokes.length; i += 50) d.apply([{ type: 'addObjects', pageId: P, objects: strokes.slice(i, i + 50) }])
    const tApply = performance.now() - t0
    t0 = performance.now()
    const snap = d.exportSnapshot()
    const tSnap = performance.now() - t0
    t0 = performance.now()
    const loaded = NotebookDocument.fromSnapshot(snap)
    const n = loaded.objects(P).length
    const tLoad = performance.now() - t0
    console.log(`[perf] apply ${tApply.toFixed(0)}ms, snapshot ${tSnap.toFixed(0)}ms (${(snap.length / 1e6).toFixed(2)}MB), load ${tLoad.toFixed(0)}ms`)
    expect(n).toBe(5000)
    expect(tApply).toBeLessThan(20000)
    expect(tSnap).toBeLessThan(10000)
    expect(tLoad).toBeLessThan(10000)
  }, 60000)
})
