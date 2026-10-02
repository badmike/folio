import { describe, expect, it } from 'vitest'
import { cer, createCorrector, emptyProfile, learnCorrection, learnWords, sanitizeProfile } from '../src/profile'
import { calibrate, DEFAULT_TUNING } from '../src/calibrate'
import { estimateSlant, planRaster } from '../src/raster'
import { makeStroke, polyline } from './helpers'

describe('learning from corrections', () => {
  it('fixes a word the user corrected, keeping its case and punctuation', () => {
    const p = emptyProfile()
    expect(learnCorrection(p, 'Buy rnilk and eggs', 'Buy milk and eggs')).toBe(true)
    const correct = createCorrector(p)
    expect(correct('Rnilk, bread')).toBe('Milk, bread')
  })

  it('applies a learned character mix-up to other words from the vocabulary only', () => {
    const p = emptyProfile()
    learnCorrection(p, 'rnodern art', 'modern art')
    learnWords(p, 'meeting with the moderator')
    const correct = createCorrector(p)
    expect(correct('the rnoderator')).toBe('the moderator')
    // unknown words and words without a learned mix-up stay as read
    expect(correct('rnarble vocabulary')).toBe('rnarble vocabulary')
  })

  it('ignores rewrites and needs two sightings to change a word the user also writes', () => {
    const p = emptyProfile()
    expect(learnCorrection(p, 'call mum tomorrow', 'finish the essay first')).toBe(false)
    expect(p.fixes).toEqual({})
    learnWords(p, 'my cat')
    learnCorrection(p, 'the cat', 'the car')
    expect(createCorrector(p)('cat')).toBe('cat')
    learnCorrection(p, 'a cat', 'a car')
    expect(createCorrector(p)('cat')).toBe('car')
  })

  it('round-trips through storage and drops invalid data', () => {
    const p = emptyProfile()
    learnCorrection(p, 'helIo', 'hello')
    p.raster = { slant: 0.2, targetHeight: 120, lineWidthScale: 1.2 }
    expect(sanitizeProfile(JSON.parse(JSON.stringify(p)))).toEqual(p)
    expect(sanitizeProfile({ words: { a: 'x' }, raster: { slant: 'no' } })).toEqual(emptyProfile())
  })
})

describe('calibration', () => {
  const sample = (text: string) => ({ text, strokes: [makeStroke(polyline([{ x: 0, y: 30 }, { x: 10, y: 0 }, { x: 20, y: 30 }], false, 4))] })

  it('keeps the variant that reads best and reports the error rates', async () => {
    const samples = [sample('hello world'), sample('second line')]
    const result = await calibrate(samples, async (strokes, t) => {
      const truth = samples.find((s) => s.strokes === strokes)!.text
      return t.targetHeight === 130 ? truth : truth.replace(/o/g, '0')
    })
    expect(result.improved).toBe(true)
    expect(result.tuning.targetHeight).toBe(130)
    expect(result.after).toBe(0)
    expect(result.before).toBeCloseTo(cer('hell0 w0rld', 'hello world') / 2 + cer('sec0nd line', 'second line') / 2)
    expect(result.readings).toEqual(['hello world', 'second line'])
  })

  it('stays on the defaults when no variant is clearly better', async () => {
    const result = await calibrate([sample('same')], async () => 'sane')
    expect(result.improved).toBe(false)
    expect(result.tuning).toEqual(DEFAULT_TUNING)
  })
})

describe('slant', () => {
  it('measures a forward lean and shears it upright in the OCR image', () => {
    const lean = 0.3
    const k = Math.tan(lean)
    // three leaning down-up strokes
    const polys = [0, 40, 80].map((x) => polyline([{ x: x + 30 * k, y: 0 }, { x, y: 30 }, { x: x + 30 * k, y: 0 }], false, 6))
    expect(estimateSlant(polys)).toBeCloseTo(lean, 1)
    const strokes = polys.map((p) => makeStroke(p))
    const upright = planRaster(strokes, { slant: lean, deskew: false }).polylines[0]
    const xs = upright.map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1)
  })
})
