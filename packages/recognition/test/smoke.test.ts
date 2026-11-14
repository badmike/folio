/**
 * Optional heavy smoke test (real tesseract.js in node). Run with:
 *   SMOKE=1 pnpm --filter @folio/recognition exec vitest run test/smoke.test.ts
 */
import { describe, expect, it } from 'vitest'
import { TesseractRecognizer } from '../src/recognizers/tesseract'
import { makeStroke } from './helpers'
import { createNodeTesseractWorker } from './node-tesseract'

const glyphs: Record<string, [number, number][][]> = {
  H: [[[0, 0], [0, 10]], [[8, 0], [8, 10]], [[0, 5], [8, 5]]],
  E: [[[8, 0], [0, 0], [0, 10], [8, 10]], [[0, 5], [6, 5]]],
  L: [[[0, 0], [0, 10], [8, 10]]],
  O: [[[4, 0], [8, 2], [8, 8], [4, 10], [0, 8], [0, 2], [4, 0]]],
  W: [[[0, 0], [2, 10], [5, 3], [8, 10], [10, 0]]],
  R: [[[0, 10], [0, 0], [7, 0], [8, 4], [0, 5]], [[3, 5], [8, 10]]],
  D: [[[0, 0], [0, 10], [5, 10], [8, 7], [8, 3], [5, 0], [0, 0]]],
}

function word(text: string, scale = 5) {
  let x = 0
  const strokes = []
  let t = 0
  for (const ch of text) {
    for (const g of glyphs[ch]) {
      const pts: { x: number; y: number }[] = []
      for (let i = 0; i < g.length - 1; i++) {
        const [ax, ay] = g[i]
        const [bx, by] = g[i + 1]
        const k = 8
        for (let j = 0; j < k; j++) pts.push({ x: (x + ax + ((bx - ax) * j) / k) * scale, y: (ay + ((by - ay) * j) / k) * scale })
      }
      const [lx, ly] = g[g.length - 1]
      pts.push({ x: (x + lx) * scale, y: ly * scale })
      strokes.push(makeStroke(pts, { startedAt: (t += 300) }))
    }
    x += 13
  }
  return strokes
}

describe.skipIf(!process.env.SMOKE)('tesseract smoke', () => {
  it('recognizes block letters offline with local core + lang files', async () => {
    const rec = new TesseractRecognizer({ createWorker: createNodeTesseractWorker })
    const res = await rec.recognize(word('HELLO'), { languages: ['en', 'de'], mode: 'word' })
    console.log('SMOKE RESULT', JSON.stringify(res), rec.workerOptions())
    rec.dispose()
    expect(res?.text.toUpperCase()).toContain('HELLO')
  }, 120000)
})
