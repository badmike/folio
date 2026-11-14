import type { InkStroke, Recognition } from '@folio/document'
import type { HandwritingRecognizer, RecognitionCoordinatorApi, RecognitionRequest } from './contract'
import { RecognitionEngine } from './engine'
import type { AnalysisResult } from './engine'
import { topWords, type HandwritingProfile } from './profile'
import type { RecognizerConfig, WorkerRequest, WorkerResponse } from './protocol'
import { CLOUD_MAX_LINES, CloudRecognizer } from './recognizers/cloud'
import { median } from './geometry'
import { detectLanguage, guessSemanticType } from './text'
import { createDefaultWorker } from './worker-factory'

export interface CloudConfig {
  apiBase: string
  /** See `CloudRecognizerConfig.getToken`. */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>
  /** Evaluated before each refinement (user opt-in, online state, ...). */
  enabled: () => boolean
  /** True when this recognition already has a cloud reading: it is not sent again. */
  isRefined?: (pageId: string, recognitionId: string) => boolean
  fetch?: typeof fetch
}

export interface CoordinatorOptions {
  /** Creates the recognition worker. Default: createDefaultWorker() when `Worker` exists. */
  workerFactory?: () => Worker
  recognizerConfig?: RecognizerConfig
  cloud?: CloudConfig
  /** Inactivity before a page's queued strokes are recognized. Default 700 ms. */
  debounceMs?: number
  /**
   * Run everything in-process with this handwriting recognizer (tests, or a main-thread
   * only recognizer). Disables the worker.
   */
  handwritingRecognizer?: HandwritingRecognizer
  /**
   * Main-thread recognizer that takes precedence over the worker's Tesseract when it is
   * available (e.g. `new WebHandwritingRecognizer()`: the W3C API is not exposed in workers).
   * Grouping and shape recognition still run in the worker.
   */
  mainThreadRecognizer?: HandwritingRecognizer
  /**
   * Called when the cloud read lines: same recognition ids as before, with `refinedText` and
   * the cloud's confidence in it.
   */
  onRefined?: (pageId: string, recognitions: Recognition[]) => void
  now?: () => number
}

/** Vocabulary words sent along with a cloud request. */
const HINT_WORDS = 120

interface Pending {
  strokes: Map<string, InkStroke>
  languages: string[]
  timer: ReturnType<typeof setTimeout> | null
  waiters: { resolve: (r: Recognition[]) => void; reject: (e: unknown) => void }[]
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

/** Abstraction over "where the pipeline runs" (worker or in-process). */
interface Backend {
  recognize(strokes: InkStroke[], languages: string[]): Promise<Recognition[]>
  setProfile(profile: HandwritingProfile | undefined): void
  dispose(): void
}

export class RecognitionCoordinator implements RecognitionCoordinatorApi {
  private pending = new Map<string, Pending>()
  private tail: Promise<unknown> = Promise.resolve()
  private refinements = new Set<Promise<unknown>>()
  private disposed = false
  private readonly backend: Backend
  private readonly cloud?: { rec: CloudRecognizer; cfg: CloudConfig }
  private profile: HandwritingProfile | undefined

  constructor(private readonly opts: CoordinatorOptions = {}) {
    this.profile = opts.recognizerConfig?.profile
    this.backend = createBackend(opts)
    if (opts.cloud) this.cloud = { rec: new CloudRecognizer(opts.cloud), cfg: opts.cloud }
  }

  enqueue(req: RecognitionRequest): Promise<Recognition[]> {
    if (this.disposed) return Promise.resolve([])
    const p = this.pendingFor(req)
    return new Promise<Recognition[]>((resolve, reject) => {
      p.waiters.push({ resolve, reject })
      if (p.timer) clearTimeout(p.timer)
      p.timer = setTimeout(() => void this.flush(req.pageId), this.opts.debounceMs ?? 700)
    })
  }

  recognizeNow(req: RecognitionRequest): Promise<Recognition[]> {
    if (this.disposed) return Promise.resolve([])
    const p = this.pendingFor(req)
    return new Promise<Recognition[]>((resolve, reject) => {
      p.waiters.push({ resolve, reject })
      void this.flush(req.pageId)
    })
  }

  /** Use a new handwriting profile for the following recognitions. */
  setProfile(profile: HandwritingProfile | undefined): void {
    if (this.disposed) return
    this.profile = profile
    this.backend.setProfile(profile)
  }

  /** Resolves when all queued work and cloud refinements have finished (useful in tests). */
  async idle(): Promise<void> {
    await this.tail
    while (this.refinements.size) await Promise.allSettled([...this.refinements])
  }

  dispose(): void {
    this.disposed = true
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.waiters.forEach((w) => w.resolve([]))
    }
    this.pending.clear()
    this.backend.dispose()
  }

  private pendingFor(req: RecognitionRequest): Pending {
    let p = this.pending.get(req.pageId)
    if (!p) {
      p = { strokes: new Map(), languages: req.languages, timer: null, waiters: [] }
      this.pending.set(req.pageId, p)
    }
    for (const s of req.strokes) p.strokes.set(s.id, s) // later versions of a stroke win
    p.languages = req.languages.length ? req.languages : p.languages
    return p
  }

  private flush(pageId: string): Promise<void> {
    const p = this.pending.get(pageId)
    if (!p) return Promise.resolve()
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(pageId)
    const strokes = [...p.strokes.values()]
    // Serialise runs: the recognizers (Tesseract worker) process one job at a time anyway.
    const run = this.tail.then(async () => {
      if (this.disposed) return p.waiters.forEach((w) => w.resolve([]))
      try {
        const recs = await this.backend.recognize(strokes, p.languages)
        p.waiters.forEach((w) => w.resolve(recs))
        this.scheduleRefinement(pageId, recs, strokes, p.languages)
      } catch (e) {
        p.waiters.forEach((w) => w.reject(e))
      }
    })
    this.tail = run.catch(() => undefined)
    return run
  }

  /** Progressive refinement: never delays the local result. */
  private scheduleRefinement(pageId: string, recs: Recognition[], strokes: InkStroke[], languages: string[]) {
    const cloud = this.cloud
    const onRefined = this.opts.onRefined
    if (!cloud || !onRefined) return
    const texts = recs.filter((r) => r.kind === 'text' && !cloud.cfg.isRefined?.(pageId, r.id))
    if (texts.length === 0) return
    const job = (async () => {
      const byId = new Map(strokes.map((s) => [s.id, s]))
      const lines = texts
        .map((rec) => ({ rec, strokes: rec.strokeIds.map((id) => byId.get(id)).filter((s): s is InkStroke => !!s) }))
        .filter((l) => l.strokes.length > 0)
      const words = this.profile ? topWords(this.profile, HINT_WORDS) : []
      const hint = words.length ? `Words this writer uses: ${words.join(', ')}` : undefined
      const refined: Recognition[] = []
      const lineHeight = median(recs.filter((r) => r.kind === 'text').map((r) => r.bounds.height))
      const allowed = languages.map((l) => l.split('-')[0])
      // One request per batch of lines instead of one per line.
      for (let i = 0; i < lines.length; i += CLOUD_MAX_LINES) {
        if (this.disposed || !cloud.cfg.enabled() || !(await cloud.rec.isAvailable())) break
        const batch = lines.slice(i, i + CLOUD_MAX_LINES)
        const res = await cloud.rec.recognizeLines(batch.map((l) => l.strokes), { languages, hint }).catch(() => null)
        res?.lines.forEach((text, n) => {
          const rec = batch[n].rec
          if (!text) return
          refined.push({
            ...rec,
            refinedText: text,
            confidence: res.confidence,
            language: detectLanguage(text, allowed.length ? allowed : undefined),
            semanticType: guessSemanticType(text, rec.bounds, lineHeight),
          })
        })
      }
      if (refined.length && !this.disposed) onRefined(pageId, refined)
    })()
    this.refinements.add(job)
    void job.finally(() => this.refinements.delete(job))
  }
}

export function createRecognitionCoordinator(opts: CoordinatorOptions = {}): RecognitionCoordinator {
  return new RecognitionCoordinator(opts)
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

function createBackend(opts: CoordinatorOptions): Backend {
  if (opts.handwritingRecognizer) return inProcessBackend(opts)
  const factory = opts.workerFactory ?? (typeof Worker !== 'undefined' ? createDefaultWorker : undefined)
  if (factory) {
    try {
      return workerBackend(factory(), opts)
    } catch {
      /* worker could not be created (CSP, unsupported): fall through */
    }
  }
  return inProcessBackend(opts)
}

function inProcessBackend(opts: CoordinatorOptions): Backend {
  let engine: RecognitionEngine | null = null
  let recognizer: HandwritingRecognizer | null = opts.handwritingRecognizer ?? null
  let profile = opts.recognizerConfig?.profile
  const get = async () => {
    if (engine) return engine
    if (!recognizer) {
      // lazy import keeps tesseract/web recognizers out of the way of tests using a fake
      const { createLocalRecognizer } = await import('./worker-host')
      recognizer = createLocalRecognizer(opts.recognizerConfig)
    }
    engine = new RecognitionEngine({ handwriting: recognizer, now: opts.now, profile })
    return engine
  }
  return {
    async recognize(strokes, languages) {
      return (await get()).recognize(strokes, languages)
    },
    setProfile(p) {
      profile = p
      engine?.setProfile(p)
    },
    dispose() {
      recognizer?.dispose?.()
    },
  }
}

function workerBackend(worker: Worker, opts: CoordinatorOptions): Backend {
  let nextId = 1
  const calls = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()
  worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data
    const c = calls.get(msg.id)
    if (!c) return
    calls.delete(msg.id)
    if (msg.type === 'ok') c.resolve(msg.result as never)
    else c.reject(new Error(msg.message))
  })
  worker.addEventListener('error', (e) => {
    const err = new Error((e as ErrorEvent).message || 'recognition worker error')
    for (const c of calls.values()) c.reject(err)
    calls.clear()
  })
  const call = <T>(req: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      calls.set(id, { resolve: resolve as (v: never) => void, reject })
      worker.postMessage({ ...req, id })
    })

  const ready = call<null>({ type: 'init', config: opts.recognizerConfig ?? {} })
  const main = opts.mainThreadRecognizer
  let mainEngine: RecognitionEngine | null = null
  let profile = opts.recognizerConfig?.profile

  return {
    async recognize(strokes, languages) {
      await ready
      if (main && (await main.isAvailable().catch(() => false))) {
        // Grouping + shapes in the worker, text on the main thread (browser-native API).
        const a = await call<AnalysisResult>({ type: 'analyze', strokes })
        mainEngine ??= new RecognitionEngine({ handwriting: main, now: opts.now, profile })
        const text = await mainEngine.recognizeLines(a.lines, strokes, languages, a.medianLineHeight)
        return [...a.shapes, ...text].sort((x, y) => x.bounds.y - y.bounds.y || x.bounds.x - y.bounds.x)
      }
      return call<Recognition[]>({ type: 'recognize', strokes, languages })
    },
    setProfile(p) {
      profile = p
      mainEngine?.setProfile(p)
      void call({ type: 'profile', profile: p }).catch(() => undefined)
    },
    dispose() {
      void call({ type: 'dispose' }).catch(() => undefined)
      setTimeout(() => worker.terminate(), 50)
    },
  }
}
