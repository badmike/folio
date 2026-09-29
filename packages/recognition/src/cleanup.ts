import type { ArrowObject, BaseObject, InkStroke, Recognition, ShapeObject, ShapeStyle, TextObject } from '@folio/document'
import { recognizeShape } from './shape'

/** Confidence thresholds: manual Clean Up vs. automatic conversion. */
export const MANUAL_CLEANUP_MIN_CONFIDENCE = 0.6
export const AUTO_CLEANUP_MIN_CONFIDENCE = 0.85

/** An object description without the fields the editor assigns (id, z, timestamps). */
export type Unassigned<T extends BaseObject> = Omit<T, 'id' | 'z' | 'createdAt' | 'updatedAt'>

export type CleanupProposal =
  | { kind: 'text'; recognitionId: string; confidence: number; sourceStrokeIds: string[]; object: Unassigned<TextObject> }
  | { kind: 'shape'; recognitionId: string; confidence: number; sourceStrokeIds: string[]; object: Unassigned<ShapeObject> }
  | { kind: 'arrow'; recognitionId: string; confidence: number; sourceStrokeIds: string[]; object: Unassigned<ArrowObject> }

export interface CleanupOptions {
  /** Default 0.6 (manual). Use AUTO_CLEANUP_MIN_CONFIDENCE (0.85) for auto-cleanup. */
  minConfidence?: number
  /** Shape roughness 0..3 (default 1: hand-drawn look). */
  roughness?: number
  /** Default text colour when the source strokes have none. */
  fallbackColor?: string
}

const IDENTITY = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }

/**
 * Turn recognitions into proposed replacement objects (non-destructive: the editor
 * keeps the ink and marks it `supersededBy` the new object).
 */
export function planCleanup(strokes: InkStroke[], recognitions: Recognition[], opts: CleanupOptions = {}): CleanupProposal[] {
  const min = opts.minConfidence ?? MANUAL_CLEANUP_MIN_CONFIDENCE
  const byId = new Map(strokes.map((s) => [s.id, s]))
  const out: CleanupProposal[] = []
  for (const r of recognitions) {
    if (r.confidence < min) continue
    const src = r.strokeIds.map((id) => byId.get(id)).filter((s): s is InkStroke => !!s)
    if (src.length === 0) continue
    const color = dominantColor(src, opts.fallbackColor ?? '#1e1e1e')
    if (r.kind === 'text') {
      const text = r.text?.trim()
      if (!text) continue
      out.push({
        kind: 'text',
        recognitionId: r.id,
        confidence: r.confidence,
        sourceStrokeIds: [...r.strokeIds],
        object: {
          type: 'text',
          transform: { ...IDENTITY, x: r.bounds.x, y: r.bounds.y },
          text,
          fontSize: estimateFontSize(r.bounds.height),
          fontFamily: 'hand',
          color,
          semanticType: r.semanticType,
          sourceStrokeIds: [...r.strokeIds],
        },
      })
      continue
    }
    if (r.kind === 'shape') {
      const match = recognizeShape(src)
      if (!match) continue
      const style = shapeStyle(src, color, r.id, opts.roughness ?? 1)
      if (match.shape === 'arrow' && match.points) {
        out.push({
          kind: 'arrow',
          recognitionId: r.id,
          confidence: r.confidence,
          sourceStrokeIds: [...r.strokeIds],
          object: {
            type: 'arrow',
            transform: { ...IDENTITY },
            start: { ...match.points[0] },
            end: { ...match.points[1] },
            style,
            startHead: 'none',
            endHead: 'arrow',
            sourceStrokeIds: [...r.strokeIds],
          },
        })
      } else if (match.shape === 'line' && match.points) {
        const [a, b] = match.points
        out.push({
          kind: 'shape',
          recognitionId: r.id,
          confidence: r.confidence,
          sourceStrokeIds: [...r.strokeIds],
          object: {
            type: 'shape',
            kind: 'line',
            // horizontal line of the right length, rotated about its start point
            transform: { x: a.x, y: a.y, rotation: match.rotation, scaleX: 1, scaleY: 1 },
            width: Math.hypot(b.x - a.x, b.y - a.y),
            height: 0,
            style,
            sourceStrokeIds: [...r.strokeIds],
          },
        })
      } else if (match.shape !== 'arrow' && match.shape !== 'line') {
        const { bounds, rotation } = match
        const cx = bounds.x + bounds.width / 2
        const cy = bounds.y + bounds.height / 2
        // local origin such that rotating about the box centre keeps the centre fixed
        const c = Math.cos(rotation)
        const s = Math.sin(rotation)
        const hx = bounds.width / 2
        const hy = bounds.height / 2
        out.push({
          kind: 'shape',
          recognitionId: r.id,
          confidence: r.confidence,
          sourceStrokeIds: [...r.strokeIds],
          object: {
            type: 'shape',
            kind: match.shape,
            transform: { x: cx - (hx * c - hy * s), y: cy - (hx * s + hy * c), rotation, scaleX: 1, scaleY: 1 },
            width: bounds.width,
            height: bounds.height,
            style,
            sourceStrokeIds: [...r.strokeIds],
          },
        })
      }
    }
  }
  return out
}

/** Font size (world units) from the ink line height: ~0.8x of the ascender-to-descender box. */
export function estimateFontSize(lineHeight: number): number {
  return Math.round(Math.min(160, Math.max(10, lineHeight * 0.8)) * 2) / 2
}

function dominantColor(strokes: InkStroke[], fallback: string): string {
  const counts = new Map<string, number>()
  for (const s of strokes) counts.set(s.style.color, (counts.get(s.style.color) ?? 0) + s.points.length)
  let best = fallback
  let n = 0
  for (const [c, k] of counts) if (k > n) [best, n] = [c, k]
  return best
}

function shapeStyle(strokes: InkStroke[], color: string, id: string, roughness: number): ShapeStyle {
  const w = strokes.reduce((a, s) => a + s.style.width, 0) / strokes.length
  let seed = 0
  for (let i = 0; i < id.length; i++) seed = (Math.imul(seed, 31) + id.charCodeAt(i)) >>> 0
  return {
    strokeColor: color,
    strokeWidth: Math.min(8, Math.max(1, Math.round(w * 2) / 2)),
    opacity: strokes[0].style.opacity,
    roughness,
    seed: seed % 2147483647,
  }
}
