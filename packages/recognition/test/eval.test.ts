/**
 * Measures recognition quality on real handwriting. Record samples in the app (Settings >
 * Handwriting samples), then run:
 *   EVAL_SAMPLES=/path/to/folio-handwriting-samples.json pnpm --filter @folio/recognition exec vitest run test/eval.test.ts --silent=false
 *
 * Reports the character error rate (wrong characters relative to the true text) per recognizer.
 * Optional:
 *   EVAL_API_BASE + EVAL_TOKEN  also measure the cloud recognizer, e.g. http://localhost:8989/api and dev:me
 *   EVAL_READINGS=<file.json>   also score readings from another tool: { "<name>": ["<text per sample>", ...] }
 *   EVAL_DUMP=<dir>             write each sample as <n>.png plus truth.json, as input for other tools
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'vitest'
import type { CalibrationSample } from '../src/calibrate'
import { cer } from '../src/profile'
import { rasterizeToPng } from '../src/raster'
import { CLOUD_MAX_LINES, CloudRecognizer } from '../src/recognizers/cloud'
import { TesseractRecognizer } from '../src/recognizers/tesseract'
import { createNodeTesseractWorker } from './node-tesseract'

const env = process.env
const languages = ['en', 'de']

describe.skipIf(!env.EVAL_SAMPLES)('recognition quality on recorded samples', () => {
  it('reports the character error rate per recognizer', async () => {
    const samples = JSON.parse(fs.readFileSync(env.EVAL_SAMPLES!, 'utf8')) as CalibrationSample[]
    const readings: Record<string, string[]> = {}

    const tesseract = new TesseractRecognizer({ createWorker: createNodeTesseractWorker })
    readings[tesseract.id] = []
    for (const s of samples) readings[tesseract.id].push((await tesseract.recognize(s.strokes, { languages, mode: 'line' }))?.text ?? '')
    tesseract.dispose()

    if (env.EVAL_API_BASE) {
      const cloud = new CloudRecognizer({ apiBase: env.EVAL_API_BASE, getToken: () => env.EVAL_TOKEN, timeoutMs: 60_000 })
      readings[cloud.id] = []
      for (let i = 0; i < samples.length; i += CLOUD_MAX_LINES) {
        const batch = samples.slice(i, i + CLOUD_MAX_LINES)
        const res = await cloud.recognizeLines(batch.map((s) => s.strokes), { languages })
        readings[cloud.id].push(...(res?.lines ?? batch.map(() => '')))
      }
    }

    if (env.EVAL_READINGS) Object.assign(readings, JSON.parse(fs.readFileSync(env.EVAL_READINGS, 'utf8')))

    if (env.EVAL_DUMP) {
      fs.mkdirSync(env.EVAL_DUMP, { recursive: true })
      for (const [i, s] of samples.entries()) fs.writeFileSync(path.join(env.EVAL_DUMP, `${i}.png`), (await rasterizeToPng(s.strokes)).png)
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
