import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudRecognizer, compactStrokes } from '../src/recognizers/cloud'
import { WebHandwritingRecognizer } from '../src/recognizers/web'
import { letters } from './fixtures'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WebHandwritingRecognizer', () => {
  it('is unavailable without the API', async () => {
    expect(await new WebHandwritingRecognizer({}).isAvailable()).toBe(false)
    expect(await new WebHandwritingRecognizer({}).recognize(letters('a', 0, 0, 2, 0), { languages: ['en'] })).toBeNull()
  })

  it('feeds world-space points with absolute times and returns the top prediction', async () => {
    const added: { x: number; y: number; t?: number }[][] = []
    class FakeStroke {
      pts: { x: number; y: number; t?: number }[] = []
      addPoint(p: { x: number; y: number; t?: number }) {
        this.pts.push(p)
      }
    }
    vi.stubGlobal('HandwritingStroke', FakeStroke)
    const nav = {
      queryHandwritingRecognizerSupport: async ({ languages }: { languages: string[] }) => ({ languages: languages[0] === 'en' || languages[0] === 'de' }),
      createHandwritingRecognizer: async ({ languages }: { languages: string[] }) => ({
        startDrawing: () => ({
          addStroke: (s: FakeStroke) => added.push(s.pts),
          getPrediction: async () => (languages[0] === 'de' ? [{ text: 'Grüße' }, { text: 'Gruße' }] : [{ text: 'Grube' }]),
          clear: () => undefined,
        }),
        finish: () => undefined,
      }),
    }
    const rec = new WebHandwritingRecognizer(nav)
    expect(await rec.isAvailable()).toBe(true)
    const strokes = letters('a', 0, 0, 2, 1000).map((s) => ({ ...s, transform: { ...s.transform, x: 100 } }))
    const res = await rec.recognize(strokes, { languages: ['en', 'de'] })
    expect(added).toHaveLength(4) // 2 strokes x 2 languages
    expect(added[0][0].x).toBeGreaterThanOrEqual(100) // transform applied
    expect(added[0][0].t).toBe(1000) // startedAt + t offset
    expect(res).toMatchObject({ text: 'Grüße', language: 'de', recognizer: 'web-handwriting' })
    expect(res?.alternatives).toEqual(['Gruße'])
  })
})

describe('CloudRecognizer', () => {
  it('posts image + languages + optional strokes and parses the response', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const rec = new CloudRecognizer({
      apiBase: 'https://x.test/api',
      getToken: async () => 'abc',
      includeStrokes: true,
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init }
        return new Response(JSON.stringify({ text: ' refined ', confidence: 2 }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const res = await rec.recognize(letters('a', 0, 0, 3, 0), { languages: ['de'] })
    expect(seen!.url).toBe('https://x.test/api/ai/recognize')
    const body = JSON.parse(seen!.init.body as string)
    expect(body.languages).toEqual(['de'])
    expect(body.strokes).toHaveLength(3)
    expect(body.image.startsWith('iVBOR')).toBe(true)
    expect(res).toEqual({ text: 'refined', confidence: 1, language: undefined, recognizer: 'cloud' })
  })

  it('returns null on HTTP errors, network errors and without token', async () => {
    const mk = (f: unknown, token: string | null = 't') => new CloudRecognizer({ apiBase: 'x', getToken: () => token, fetch: f as typeof fetch })
    const s = letters('a', 0, 0, 3, 0)
    expect(await mk(async () => new Response('no', { status: 500 })).recognize(s, { languages: [] })).toBeNull()
    expect(await mk(async () => { throw new Error('offline') }).recognize(s, { languages: [] })).toBeNull()
    expect(await mk(async () => new Response('{}')).recognize(s, { languages: [] })).toBeNull()
    expect(await mk(vi.fn(), null).recognize(s, { languages: [] })).toBeNull()
    expect(await mk(vi.fn(), null).isAvailable()).toBe(false)
  })

  it('compactStrokes emits x,y,t triples', () => {
    expect(compactStrokes(letters('a', 0, 0, 1, 500))[0].length % 3).toBe(0)
  })
})
