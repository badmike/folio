import type { InkStroke, Recognition, Rect } from '@folio/document'
import type { HandwritingRecognizer } from './contract'
import { findShapeCandidates, groupTextStrokes } from './grouping'
import type { GroupingOptions } from './grouping'
import { median, strokeWorldPoints, boundsOf } from './geometry'
import { recognizeShape, SHAPE_RECOGNIZER_ID } from './shape'
import type { HandwritingResultEx } from './recognizers/types'
import { cleanRecognizedText, detectLanguage, guessSemanticType, recognitionId } from './text'

/** A text line waiting for handwriting recognition. */
export interface LineJob {
  strokeIds: string[]
  bounds: Rect
  mode: 'word' | 'line'
}

export interface AnalysisResult {
  /** Fully formed shape recognitions. */
  shapes: Recognition[]
  /** Text lines still to be recognized. */
  lines: LineJob[]
  /** Median line height (for semantic-type guessing). */
  medianLineHeight: number
  textHeight: number
}

export interface EngineConfig {
  handwriting?: HandwritingRecognizer | null
  now?: () => number
  /** Drop text results below this confidence. Default 0.2. */
  minTextConfidence?: number
  grouping?: GroupingOptions
}

/**
 * The recognition pipeline: grouping -> shape recognition -> handwriting recognition.
 * Pure (no DOM); runs inside the recognition worker or in-process.
 */
export class RecognitionEngine {
  constructor(private readonly cfg: EngineConfig = {}) {}

  private now(): number {
    return (this.cfg.now ?? Date.now)()
  }

  /** Grouping + shape recognition. Cheap; no handwriting recognizer involved. */
  analyze(allStrokes: InkStroke[]): AnalysisResult {
    const strokes = allStrokes.filter((s) => s.style.tool !== 'highlighter' && s.points.length >= 6)
    const { candidates, rest } = findShapeCandidates(strokes, this.cfg.grouping)
    const shapes: Recognition[] = []
    const text: InkStroke[] = [...rest]
    for (const cluster of candidates) {
      let match = recognizeShape(cluster)
      let used = cluster
      if (!match && cluster.length > 1) {
        // head strokes were probably text next to a line: try the shaft alone
        match = recognizeShape([cluster[0]])
        used = [cluster[0]]
        text.push(...cluster.slice(1))
      }
      if (match) {
        shapes.push(this.shapeRecognition(used, match.shape, match.confidence))
      } else {
        text.push(...used)
      }
    }
    const grouped = groupTextStrokes(text, this.cfg.grouping)
    const wordsPerLine = (line: { bounds: Rect }) =>
      grouped.words.filter((w) => contains(line.bounds, w.bounds)).length
    const lines: LineJob[] = grouped.lines.map((l) => ({
      strokeIds: l.strokeIds,
      bounds: l.bounds,
      mode: wordsPerLine(l) <= 1 ? 'word' : 'line',
    }))
    shapes.sort(byPosition)
    lines.sort(byPosition)
    return {
      shapes,
      lines,
      medianLineHeight: median(lines.map((l) => l.bounds.height)),
      textHeight: grouped.textHeight,
    }
  }

  private shapeRecognition(strokes: InkStroke[], shape: NonNullable<Recognition['shape']>, confidence: number): Recognition {
    const ids = strokes.map((s) => s.id)
    return {
      id: recognitionId(ids),
      kind: 'shape',
      strokeIds: ids,
      bounds: boundsOf(strokes.flatMap(strokeWorldPoints)),
      shape,
      confidence,
      recognizer: SHAPE_RECOGNIZER_ID,
      createdAt: this.now(),
    }
  }

  /** Run the handwriting recognizer over analysed lines. */
  async recognizeLines(
    lines: LineJob[],
    strokes: InkStroke[],
    languages: string[],
    medianLineHeight: number,
    handwriting: HandwritingRecognizer | null | undefined = this.cfg.handwriting,
  ): Promise<Recognition[]> {
    if (!handwriting || lines.length === 0) return []
    const byId = new Map(strokes.map((s) => [s.id, s]))
    const out: Recognition[] = []
    const langs = languages.length ? languages : ['en', 'de']
    for (const line of lines) {
      const group = line.strokeIds.map((id) => byId.get(id)).filter((s): s is InkStroke => !!s)
      if (group.length === 0) continue
      let res: HandwritingResultEx | null = null
      try {
        res = (await handwriting.recognize(group, { languages: langs, mode: line.mode } as { languages: string[] })) as HandwritingResultEx | null
      } catch {
        res = null // one bad line must not lose the others
      }
      if (!res || res.confidence < (this.cfg.minTextConfidence ?? 0.2)) continue
      const text = cleanRecognizedText(res.text)
      if (!text) continue
      out.push({
        id: recognitionId(line.strokeIds),
        kind: 'text',
        strokeIds: line.strokeIds,
        bounds: line.bounds,
        text,
        confidence: res.confidence,
        language: detectLanguage(text, langs.map((l) => l.split('-')[0])),
        semanticType: guessSemanticType(text, line.bounds, medianLineHeight),
        recognizer: res.recognizer ?? handwriting.id,
        alternatives: res.alternatives,
        createdAt: this.now(),
      })
    }
    return out
  }

  async recognize(strokes: InkStroke[], languages: string[]): Promise<Recognition[]> {
    const a = this.analyze(strokes)
    const text = await this.recognizeLines(a.lines, strokes, languages, a.medianLineHeight)
    return [...a.shapes, ...text].sort(byPosition)
  }
}

function contains(outer: Rect, inner: Rect): boolean {
  const e = 0.5
  return (
    inner.x >= outer.x - e &&
    inner.y >= outer.y - e &&
    inner.x + inner.width <= outer.x + outer.width + e &&
    inner.y + inner.height <= outer.y + outer.height + e
  )
}

function byPosition(a: { bounds: Rect }, b: { bounds: Rect }): number {
  return a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x
}

