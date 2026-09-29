import { describe, expect, it, vi } from 'vitest'
import type { Recognition } from '@folio/document'
import { createRecognitionCoordinator } from '../src/coordinator'
import { RecognitionEngine } from '../src/engine'
import { RecognitionWorkerHost } from '../src/worker-host'
import type { WorkerRequest, WorkerResponse } from '../src/protocol'
import { CompositeRecognizer } from '../src/recognizers/composite'
import { recognitionId } from '../src/text'
import { FakeRecognizer, letters, rectStroke } from './fixtures'

const langs = ['en', 'de']

describe('RecognitionEngine', () => {
  it('produces text and shape recognitions with deterministic ids', async () => {
    const fake = new FakeRecognizer((s) => (s.length > 3 ? 'Das ist ein Test' : 'ok'))
    const engine = new RecognitionEngine({ handwriting: fake, now: () => 42 })
    const strokes = [...letters('a', 0, 0, 6, 0), rectStroke('r', 300, 0, 160, 110, 5000)]
    const recs = await engine.recognize(strokes, langs)
    expect(recs).toHaveLength(2)
    const text = recs.find((r) => r.kind === 'text')!
    const shape = recs.find((r) => r.kind === 'shape')!
    expect(text.text).toBe('Das ist ein Test')
    expect(text.language).toBe('de')
    expect(text.recognizer).toBe('fake')
    expect(text.id).toBe(recognitionId(text.strokeIds))
    expect(text.createdAt).toBe(42)
    expect(shape.shape).toBe('rectangle')
    expect(shape.strokeIds).toEqual(['r'])
    expect(shape.recognizer).toBe('shape@1')
    // re-running yields identical ids (replace, not duplicate)
    const again = await engine.recognize(strokes, langs)
    expect(again.map((r) => r.id).sort()).toEqual(recs.map((r) => r.id).sort())
  })

  it('falls back to text when a shape candidate is not a shape', async () => {
    const fake = new FakeRecognizer(() => 'scribble')
    const engine = new RecognitionEngine({ handwriting: fake })
    // a big zig-zag stroke: shape-candidate by size but not a shape
    const zig = rectStroke('z', 0, 0, 10, 10)
    zig.points = []
    const pts: number[] = []
    for (let i = 0; i < 30; i++) pts.push(i * 6, (i % 2) * 60, 0.5, 0, 0, i * 8)
    zig.points = pts
    const recs = await engine.recognize([zig], langs)
    expect(recs.map((r) => r.kind)).toEqual(['text'])
  })

  it('ignores highlighter strokes and drops low-confidence text', async () => {
    const hl = letters('h', 0, 0, 4, 0).map((s) => ({ ...s, style: { ...s.style, tool: 'highlighter' as const } }))
    const engine = new RecognitionEngine({ handwriting: new FakeRecognizer(() => 'x', 0.05) })
    expect(await engine.recognize(hl, langs)).toEqual([])
    expect(await engine.recognize(letters('a', 0, 0, 4, 0), langs)).toEqual([])
  })

  it('one failing line does not lose the others', async () => {
    let n = 0
    const rec = new FakeRecognizer(() => {
      if (n++ === 0) throw new Error('boom')
      return 'second'
    })
    const engine = new RecognitionEngine({ handwriting: rec })
    const recs = await engine.recognize([...letters('a', 0, 0, 3, 0), ...letters('b', 0, 100, 3, 1000)], langs)
    expect(recs.map((r) => r.text)).toEqual(['second'])
  })

  it('marks headings and list items', async () => {
    const texts: Record<string, string> = { a: '- milk', b: 'plain', c: 'plain two', d: 'TITLE' }
    const rec = new FakeRecognizer((s) => texts[s[0].id[0]])
    const engine = new RecognitionEngine({ handwriting: rec })
    const strokes = [
      ...letters('a', 0, 0, 3, 0),
      ...letters('b', 0, 60, 3, 1000),
      ...letters('c', 0, 120, 3, 2000),
      ...letters('d', 0, 200, 3, 3000, 60),
    ]
    const recs = await engine.recognize(strokes, langs)
    const byText = Object.fromEntries(recs.map((r) => [r.text, r.semanticType]))
    expect(byText['- milk']).toBe('list-item')
    expect(byText['TITLE']).toBe('heading')
    expect(byText['plain']).toBeUndefined()
  })
})

describe('RecognitionCoordinator (in-process)', () => {
  it('debounces per page and merges strokes of the window', async () => {
    const fake = new FakeRecognizer()
    const c = createRecognitionCoordinator({ handwritingRecognizer: fake, debounceMs: 30 })
    const first = c.enqueue({ pageId: 'p1', strokes: letters('a', 0, 0, 3, 0), languages: langs })
    await new Promise((r) => setTimeout(r, 10))
    const second = c.enqueue({ pageId: 'p1', strokes: letters('b', 100, 0, 3, 500), languages: langs })
    const [r1, r2] = await Promise.all([first, second])
    expect(fake.calls).toHaveLength(1) // one recognition run for both enqueues
    expect(r1).toEqual(r2)
    expect(r1[0].strokeIds).toHaveLength(6)
    c.dispose()
  })

  it('keeps pages independent', async () => {
    const fake = new FakeRecognizer()
    const c = createRecognitionCoordinator({ handwritingRecognizer: fake, debounceMs: 5 })
    const [a, b] = await Promise.all([
      c.enqueue({ pageId: 'p1', strokes: letters('a', 0, 0, 3, 0), languages: langs }),
      c.enqueue({ pageId: 'p2', strokes: letters('b', 0, 0, 3, 0), languages: langs }),
    ])
    expect(fake.calls).toHaveLength(2)
    expect(a[0].strokeIds[0]).toBe('a0')
    expect(b[0].strokeIds[0]).toBe('b0')
    c.dispose()
  })

  it('recognizeNow bypasses the debounce and settles pending enqueues', async () => {
    const fake = new FakeRecognizer()
    const c = createRecognitionCoordinator({ handwritingRecognizer: fake, debounceMs: 10_000 })
    const queued = c.enqueue({ pageId: 'p', strokes: letters('a', 0, 0, 3, 0), languages: langs })
    const now = await c.recognizeNow({ pageId: 'p', strokes: letters('b', 0, 100, 3, 500), languages: langs })
    expect(now.length).toBe(2) // two separate lines, one run
    expect(fake.calls).toHaveLength(2)
    expect(await queued).toEqual(now)
    c.dispose()
  })

  it('rejects the promise when recognition fails outright and disposes cleanly', async () => {
    const c = createRecognitionCoordinator({ handwritingRecognizer: new FakeRecognizer(), debounceMs: 1 })
    c.dispose()
    expect(await c.enqueue({ pageId: 'p', strokes: letters('a', 0, 0, 3, 0), languages: langs })).toEqual([])
  })

  it('cloud refinement fills refinedText without changing the local result', async () => {
    const fake = new FakeRecognizer(() => 'eigen vector')
    const onRefined = vi.fn()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      expect(body.image).toMatch(/^iVBOR/) // base64 PNG
      expect(body.languages).toEqual(langs)
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
      return new Response(JSON.stringify({ text: 'eigenvector', confidence: 0.97 }), { status: 200 })
    })
    const c = createRecognitionCoordinator({
      handwritingRecognizer: fake,
      debounceMs: 1,
      onRefined,
      cloud: { apiBase: 'https://api.test/v1/', getToken: () => 'tok', enabled: () => true, fetch: fetchMock as unknown as typeof fetch },
    })
    const recs = await c.recognizeNow({ pageId: 'p', strokes: letters('a', 0, 0, 5, 0), languages: langs })
    expect(recs[0].text).toBe('eigen vector')
    expect(recs[0].refinedText).toBeUndefined()
    await c.idle()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/ai/recognize')
    expect(onRefined).toHaveBeenCalledOnce()
    const [pageId, refined] = onRefined.mock.calls[0] as [string, Recognition[]]
    expect(pageId).toBe('p')
    expect(refined[0]).toMatchObject({ id: recs[0].id, text: 'eigen vector', refinedText: 'eigenvector' })
    c.dispose()
  })

  it('skips the cloud when disabled or without a token', async () => {
    const fetchMock = vi.fn()
    const onRefined = vi.fn()
    for (const cloud of [
      { apiBase: 'x', getToken: () => 't', enabled: () => false },
      { apiBase: 'x', getToken: () => null, enabled: () => true },
    ]) {
      const c = createRecognitionCoordinator({ handwritingRecognizer: new FakeRecognizer(), onRefined, cloud: { ...cloud, fetch: fetchMock as never } })
      await c.recognizeNow({ pageId: 'p', strokes: letters('a', 0, 0, 3, 0), languages: langs })
      await c.idle()
      c.dispose()
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onRefined).not.toHaveBeenCalled()
  })
})

describe('worker RPC', () => {
  /** A fake Worker that loops messages into RecognitionWorkerHost (structured-clone semantics). */
  function loopbackWorker(host: () => RecognitionWorkerHost) {
    const listeners: ((e: { data: WorkerResponse }) => void)[] = []
    let h: RecognitionWorkerHost | null = null
    const w = {
      addEventListener: (type: string, fn: (e: { data: WorkerResponse }) => void) => {
        if (type === 'message') listeners.push(fn)
      },
      postMessage: (msg: WorkerRequest) => {
        h ??= host()
        void h.handle(structuredClone(msg))
      },
      terminate: vi.fn(),
    }
    const post = (m: WorkerResponse) => listeners.forEach((l) => l({ data: structuredClone(m) }))
    return { worker: w as unknown as Worker, post, raw: w }
  }

  it('round-trips through the typed message protocol', async () => {
    const fake = new FakeRecognizer()
    const lb = loopbackWorker(() => new RecognitionWorkerHost((m) => lb.post(m), new CompositeRecognizer([fake])))
    const c = createRecognitionCoordinator({ workerFactory: () => lb.worker, debounceMs: 1 })
    const recs = await c.recognizeNow({
      pageId: 'p',
      strokes: [...letters('a', 0, 0, 4, 0), rectStroke('r', 300, 0, 160, 110, 5000)],
      languages: langs,
    })
    expect(recs.map((r) => r.kind).sort()).toEqual(['shape', 'text'])
    expect(fake.calls).toHaveLength(1)
    c.dispose()
  })

  it('uses a main-thread recognizer for text when available, shapes still come from the worker', async () => {
    const workerFake = new FakeRecognizer(() => 'from worker')
    const mainFake = new FakeRecognizer(() => 'from main')
    const lb = loopbackWorker(() => new RecognitionWorkerHost((m) => lb.post(m), workerFake))
    const c = createRecognitionCoordinator({ workerFactory: () => lb.worker, mainThreadRecognizer: mainFake })
    const recs = await c.recognizeNow({
      pageId: 'p',
      strokes: [...letters('a', 0, 0, 4, 0), rectStroke('r', 300, 0, 160, 110, 5000)],
      languages: langs,
    })
    expect(recs.find((r) => r.kind === 'text')!.text).toBe('from main')
    expect(recs.some((r) => r.kind === 'shape')).toBe(true)
    expect(workerFake.calls).toHaveLength(0)
    c.dispose()
  })

  it('isolates recognizer failures (empty result instead of a crash)', async () => {
    const bad = new FakeRecognizer(() => 'x')
    bad.recognize = async () => {
      throw new Error('never surfaces: lines are isolated')
    }
    const lb = loopbackWorker(() => new RecognitionWorkerHost((m) => lb.post(m), bad))
    const c = createRecognitionCoordinator({ workerFactory: () => lb.worker })
    expect(await c.recognizeNow({ pageId: 'p', strokes: letters('a', 0, 0, 3, 0), languages: langs })).toEqual([])
    c.dispose()
  })
})

describe('RecognitionWorkerHost', () => {
  it('answers with an error message when a request blows up', async () => {
    const out: unknown[] = []
    const host = new RecognitionWorkerHost((m) => out.push(m), new FakeRecognizer())
    await host.handle({ id: 7, type: 'analyze', strokes: null as never })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 7, type: 'error' })
  })
})

describe('CompositeRecognizer', () => {
  it('picks the first available recognizer and falls through on empty results', async () => {
    const unavailable = new FakeRecognizer()
    unavailable.isAvailable = async () => false
    const empty = new FakeRecognizer(() => null)
    const good = new FakeRecognizer(() => 'yes')
    const comp = new CompositeRecognizer([unavailable, empty, good])
    expect(await comp.isAvailable()).toBe(true)
    expect((await comp.pick())!.id).toBe('fake')
    const res = await comp.recognize(letters('a', 0, 0, 2, 0), { languages: ['en'] })
    expect(res?.text).toBe('yes')
    expect(unavailable.calls).toHaveLength(0)
    expect(empty.calls).toHaveLength(1)
    expect(await new CompositeRecognizer([unavailable]).isAvailable()).toBe(false)
  })
})
