import type { InkStroke, Recognition, ShapeKind } from '@folio/document'

/** A group of strokes that likely forms a word/line/block or a shape. */
export interface StrokeGroup {
  strokeIds: string[]
  bounds: { x: number; y: number; width: number; height: number }
  kind: 'word' | 'line' | 'block' | 'shape-candidate'
}

export interface ShapeMatch {
  shape: ShapeKind | 'arrow'
  confidence: number
  /** World-space axis-aligned box (for line/arrow: start/end in points). */
  bounds: { x: number; y: number; width: number; height: number }
  rotation: number
  points?: { x: number; y: number }[]
}

export interface HandwritingResult {
  text: string
  confidence: number
  alternatives?: string[]
  language?: string
}

export interface HandwritingRecognizer {
  readonly id: string
  isAvailable(): Promise<boolean>
  /** Strokes are in world coordinates (transforms already applied). */
  recognize(strokes: InkStroke[], opts: { languages: string[] }): Promise<HandwritingResult | null>
  dispose?(): void
}

export interface RecognitionRequest {
  pageId: string
  strokes: InkStroke[]
  languages: string[]
}

export interface RecognitionCoordinatorApi {
  /** Queue strokes for background recognition; resolves with new recognitions for affected groups. */
  enqueue(req: RecognitionRequest): Promise<Recognition[]>
  /** Recognize explicitly (Clean Up) — bypasses debounce. */
  recognizeNow(req: RecognitionRequest): Promise<Recognition[]>
  dispose(): void
}
