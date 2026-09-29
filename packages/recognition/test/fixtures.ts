import type { InkStroke } from '@folio/document'
import type { HandwritingRecognizer, HandwritingResult } from '../src/contract'
import { makeStroke, polyline } from './helpers'

export function letters(id: string, x: number, y: number, n: number, t0: number, H = 24): InkStroke[] {
  const out: InkStroke[] = []
  for (let i = 0; i < n; i++) {
    const lx = x + i * H * 0.55
    out.push(
      makeStroke(polyline([{ x: lx, y: y + H }, { x: lx + H * 0.2, y }, { x: lx + H * 0.4, y: y + H }], false, 3), {
        id: `${id}${i}`,
        startedAt: t0 + i * 200,
      }),
    )
  }
  return out
}

export class FakeRecognizer implements HandwritingRecognizer {
  readonly id = 'fake'
  calls: { ids: string[]; opts: unknown }[] = []
  constructor(private readonly textFor: (strokes: InkStroke[]) => string | null = () => 'hello world', private readonly confidence = 0.9) {}
  async isAvailable() {
    return true
  }
  async recognize(strokes: InkStroke[], opts: { languages: string[] }): Promise<HandwritingResult | null> {
    this.calls.push({ ids: strokes.map((s) => s.id), opts })
    const text = this.textFor(strokes)
    return text === null ? null : { text, confidence: this.confidence }
  }
}

export function rectStroke(id: string, x: number, y: number, w: number, h: number, t = 0) {
  return makeStroke(polyline([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y: y + 1 }], false, 3), { id, startedAt: t })
}
