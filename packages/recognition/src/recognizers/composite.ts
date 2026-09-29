import type { InkStroke } from '@folio/document'
import type { HandwritingRecognizer } from '../contract'
import type { HandwritingResultEx, LocalRecognizer, RecognizeOpts } from './types'

/** Picks the first available recognizer (priority order) and delegates to it. */
export class CompositeRecognizer implements LocalRecognizer {
  readonly id = 'composite'
  constructor(private readonly recognizers: HandwritingRecognizer[]) {}

  /** First available recognizer, or null. */
  async pick(): Promise<HandwritingRecognizer | null> {
    for (const r of this.recognizers) {
      try {
        if (await r.isAvailable()) return r
      } catch {
        /* treat as unavailable */
      }
    }
    return null
  }

  async isAvailable(): Promise<boolean> {
    return (await this.pick()) !== null
  }

  async recognize(strokes: InkStroke[], opts: RecognizeOpts): Promise<HandwritingResultEx | null> {
    // Fall through to the next recognizer when one is available but yields nothing/fails.
    for (const r of this.recognizers) {
      try {
        if (!(await r.isAvailable())) continue
        const res = (await r.recognize(strokes, opts)) as HandwritingResultEx | null
        if (res && res.text.trim()) return { ...res, recognizer: res.recognizer ?? r.id }
      } catch {
        /* try the next one */
      }
    }
    return null
  }

  dispose(): void {
    for (const r of this.recognizers) r.dispose?.()
  }
}
