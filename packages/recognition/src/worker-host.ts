import { RecognitionEngine } from './engine'
import type { HandwritingRecognizer } from './contract'
import type { RecognizerConfig, WorkerRequest, WorkerResponse } from './protocol'
import { CompositeRecognizer } from './recognizers/composite'
import { TesseractRecognizer } from './recognizers/tesseract'
import { WebHandwritingRecognizer } from './recognizers/web'

/** Build the default local recognizer chain: browser Handwriting API > Tesseract. */
export function createLocalRecognizer(config: RecognizerConfig = {}): CompositeRecognizer {
  const langs = config.languages ?? ['en', 'de']
  const chain: HandwritingRecognizer[] = [
    new WebHandwritingRecognizer(),
    new TesseractRecognizer({ baseUrl: config.tesseractBaseUrl ?? '/tesseract/', languages: langs }),
  ]
  return new CompositeRecognizer(chain)
}

/**
 * Message handler for the recognition worker. Transport-agnostic (takes a `post`
 * function) so it can run inside a real Worker or be looped back in tests.
 */
export class RecognitionWorkerHost {
  private engine: RecognitionEngine
  private recognizer: HandwritingRecognizer
  private readonly injected: boolean

  /** `recognizer` (tests) replaces the default Web/Tesseract chain and survives `init`. */
  constructor(
    private readonly post: (msg: WorkerResponse) => void,
    recognizer?: HandwritingRecognizer,
  ) {
    this.injected = !!recognizer
    this.recognizer = recognizer ?? createLocalRecognizer()
    this.engine = new RecognitionEngine({ handwriting: this.recognizer })
  }

  async handle(req: WorkerRequest): Promise<void> {
    try {
      switch (req.type) {
        case 'init':
          if (!this.injected) {
            this.recognizer.dispose?.()
            this.recognizer = createLocalRecognizer(req.config)
          }
          this.engine = new RecognitionEngine({ handwriting: this.recognizer })
          this.post({ id: req.id, type: 'ok', result: null })
          return
        case 'analyze':
          this.post({ id: req.id, type: 'ok', result: this.engine.analyze(req.strokes) })
          return
        case 'recognize':
          this.post({ id: req.id, type: 'ok', result: await this.engine.recognize(req.strokes, req.languages) })
          return
        case 'recognizeLines':
          this.post({
            id: req.id,
            type: 'ok',
            result: await this.engine.recognizeLines(req.lines, req.strokes, req.languages, req.medianLineHeight),
          })
          return
        case 'dispose':
          this.recognizer.dispose?.()
          this.post({ id: req.id, type: 'ok', result: null })
          return
      }
    } catch (e) {
      this.post({ id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }
}
