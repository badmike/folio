import type { InkStroke, Recognition } from '@folio/document'
import type { AnalysisResult, LineJob } from './engine'

export interface RecognizerConfig {
  /** Base URL where TESSERACT_ASSETS are served. Default '/tesseract/'. */
  tesseractBaseUrl?: string
  /** BCP-47-ish language codes. Default ['en', 'de']. */
  languages?: string[]
}

/** Requests (main thread -> worker). `id` correlates the response. */
export type WorkerRequest =
  | { id: number; type: 'init'; config: RecognizerConfig }
  | { id: number; type: 'recognize'; strokes: InkStroke[]; languages: string[] }
  | { id: number; type: 'analyze'; strokes: InkStroke[] }
  | { id: number; type: 'recognizeLines'; strokes: InkStroke[]; lines: LineJob[]; languages: string[]; medianLineHeight: number }
  | { id: number; type: 'dispose' }

export type WorkerResponse =
  | { id: number; type: 'ok'; result: Recognition[] | AnalysisResult | null }
  | { id: number; type: 'error'; message: string }
