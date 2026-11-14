/**
 * Measures recognition quality on real handwriting. Record samples in the app (Settings >
 * Handwriting samples), then run:
 *   EVAL_SAMPLES=/path/to/folio-handwriting-samples.json pnpm --filter @folio/recognition exec vitest run test/eval.test.ts --silent=false
 *
 * Reports the character error rate (wrong characters relative to the true text) per recognizer.
 * Optional:
 *   EVAL_API_BASE + EVAL_TOKEN  also measure the cloud recognizer, e.g. http://localhost:8989/api and dev:me
 *   EVAL_READINGS=<file.json>   also score readings from another tool: { "<name>": ["<text per sample>", ...] }
 *   EVAL_DUMP=<dir>             write each written row as <sample>.<row>.png plus truth.json, as input for other tools
 *
 * A sample may span several rows of the recorder: its rows are read one by one and joined with
 * spaces. "+ grouping" is the same recognizer on the lines the app's own stroke grouping finds, so
 * the difference between the two is what grouping costs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'vitest'
import type { InkStroke } from '@folio/document'
import type { CalibrationSample } from '../src/calibrate'
import { boundsOf, strokeWorldPoints } from '../src/geometry'
import { groupTextStrokes } from '../src/grouping'
import { cer } from '../src/profile'
import { rasterizeToPng } from '../src/raster'
import { CLOUD_MAX_LINES, CloudRecognizer } from '../src/recognizers/cloud'
import { TesseractRecognizer } from '../src/recognizers/tesseract'
import { createNodeTesseractWorker } from './node-tesseract'

const env = process.env
const languages = ['en', 'de']

/** Rows in the recorder are about 170 px apart; strokes of one row stay well within this. */
const ROW_GAP = 40

/** The rows a sample was written on, top to bottom, split where the strokes' vertical centres jump. */
function rows(strokes: InkStroke[]): InkStroke[][] {
  const centre = (s: InkStroke) => {
    const b = boundsOf(strokeWorldPoints(s))
    return b.y + b.height / 2
  }
  const sorted = strokes.map((s) => ({ s, y: centre(s) })).sort((a, b) => a.y - b.y)
  const out: InkStroke[][] = []
  sorted.forEach((c, i) => {
    if (i === 0 || c.y - sorted[i - 1].y > ROW_GAP) out.push([])
    out[out.length - 1].push(c.s)
  })
  return out
}

/** The lines the app's stroke grouping finds in a sample, top to bottom. */
function groupedLines(strokes: InkStroke[]): InkStroke[][] {
  const byId = new Map(strokes.map((s) => [s.id, s]))
  return groupTextStrokes(strokes)
    .lines.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
    .map((l) => l.strokeIds.map((id) => byId.get(id)!))
}

describe.skipIf(!env.EVAL_SAMPLES)('recognition quality on recorded samples', () => {
  it('reports the character error rate per recognizer', async () => {
    const samples = JSON.parse(fs.readFileSync(env.EVAL_SAMPLES!, 'utf8')) as CalibrationSample[]
    const sampleRows = samples.map((s) => rows(s.strokes))
    const readings: Record<string, string[]> = {}

    const tesseract = new TesseractRecognizer({ createWorker: createNodeTesseractWorker })
    const readLines = async (lines: InkStroke[][]) => {
      const texts: string[] = []
      for (const line of lines) texts.push((await tesseract.recognize(line, { languages, mode: 'line' }))?.text ?? '')
      return texts.join(' ')
    }
    readings[tesseract.id] = []
    readings[`${tesseract.id} + grouping`] = []
    for (const [i, s] of samples.entries()) {
      readings[tesseract.id].push(await readLines(sampleRows[i]))
      readings[`${tesseract.id} + grouping`].push(await readLines(groupedLines(s.strokes)))
    }
    tesseract.dispose()

    if (env.EVAL_API_BASE) {
      const cloud = new CloudRecognizer({ apiBase: env.EVAL_API_BASE, getToken: () => env.EVAL_TOKEN, timeoutMs: 60_000 })
      readings[cloud.id] = []
      for (const r of sampleRows) {
        const texts: string[] = []
        for (let i = 0; i < r.length; i += CLOUD_MAX_LINES) {
          const batch = r.slice(i, i + CLOUD_MAX_LINES)
          texts.push(...((await cloud.recognizeLines(batch, { languages }))?.lines ?? []))
        }
        readings[cloud.id].push(texts.join(' '))
      }
    }

    if (env.EVAL_READINGS) Object.assign(readings, JSON.parse(fs.readFileSync(env.EVAL_READINGS, 'utf8')))

    if (env.EVAL_DUMP) {
      fs.mkdirSync(env.EVAL_DUMP, { recursive: true })
      for (const [i, r] of sampleRows.entries()) {
        for (const [n, row] of r.entries()) fs.writeFileSync(path.join(env.EVAL_DUMP, `${i}.${n}.png`), (await rasterizeToPng(row)).png)
      }
      fs.writeFileSync(path.join(env.EVAL_DUMP, 'truth.json'), JSON.stringify(samples.map((s) => s.text)))
    }

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
    console.table(
      Object.entries(readings).map(([recognizer, read]) => {
        const errors = samples.map((s, i) => cer(read[i] ?? '', s.text))
        return {
          recognizer,
          samples: samples.length,
          'mean CER %': Math.round(mean(errors) * 1000) / 10,
          'exact lines %': Math.round(mean(errors.map((e) => (e === 0 ? 1 : 0))) * 1000) / 10,
        }
      }),
    )
    console.table(samples.map((s, i) => ({ truth: s.text, ...Object.fromEntries(Object.entries(readings).map(([name, read]) => [name, read[i] ?? ''])) })))
  }, 1_800_000)
})
