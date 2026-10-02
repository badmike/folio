import type { InkStroke, Transform, Vec2 } from '@folio/document'
import { boundsOf, median, strokeWorldPoints } from './geometry'
import { findShapeCandidates, groupTextStrokes } from './grouping'
import { estimateSkew, lowerEnvelope } from './raster'

/**
 * Tidy handwriting: straighten each line, give the lines of a paragraph an even pitch
 * and a shared left margin, optionally on the page rules. The ink keeps its shape, only
 * stroke transforms change. Drawings (shape candidates) stay where they are.
 */

export interface TidyOptions {
  /** Spacing of the page's horizontal rules (ruled or grid pages). Baselines snap onto them. */
  ruleSpacing?: number
}

export interface StrokeMove {
  id: string
  transform: Transform
}

const MIN_TILT = (0.5 * Math.PI) / 180
const MAX_TILT = (25 * Math.PI) / 180
/** Left edges within this many text heights of a paragraph's margin snap to it; further in is an indent. */
const MARGIN_SNAP = 0.75
/** Moves below this (world units) are not worth an update. */
const MIN_SHIFT = 0.05

interface Line {
  strokes: InkStroke[]
  pivot: Vec2
  /** Baseline angle that gets rotated away. */
  tilt: number
  /** Baseline y and left edge after straightening. */
  baseline: number
  left: number
}

export function planTidy(strokes: InkStroke[], opts: TidyOptions = {}): StrokeMove[] {
  const { rest } = findShapeCandidates(strokes.filter((s) => s.points.length >= 6))
  const text = groupTextStrokes(rest)
  const byId = new Map(rest.map((s) => [s.id, s]))
  const lineOf = new Map<string, Line>()
  const lines = text.lines.map((g) => {
    const line = measureLine(g.strokeIds.map((id) => byId.get(id)!))
    for (const id of g.strokeIds) lineOf.set(id, line)
    return line
  })

  const rule = opts.ruleSpacing && opts.ruleSpacing > 0 ? opts.ruleSpacing : undefined
  const snap = (y: number) => (rule ? Math.round(y / rule) * rule : y)
  const target = new Map<Line, { baseline: number; left: number }>()

  for (const block of text.blocks) {
    const ls = [...new Set(block.strokeIds.map((id) => lineOf.get(id)!))].sort((a, b) => a.baseline - b.baseline)
    const gaps = ls.slice(1).map((l, i) => l.baseline - ls[i].baseline)
    let pitch = median(gaps)
    if (rule) pitch = Math.max(1, Math.round(pitch / rule)) * rule
    const margin = Math.min(...ls.map((l) => l.left))
    let y = snap(ls[0].baseline)
    ls.forEach((l, i) => {
      // keep deliberate blank lines inside a paragraph
      if (i > 0) y += Math.max(1, Math.round(gaps[i - 1] / pitch)) * pitch
      target.set(l, { baseline: y, left: l.left - margin < MARGIN_SNAP * text.textHeight ? margin : l.left })
    })
  }

  const moves: StrokeMove[] = []
  for (const l of lines) {
    const t = target.get(l) ?? { baseline: snap(l.baseline), left: l.left }
    const dx = t.left - l.left
    const dy = t.baseline - l.baseline
    if (l.tilt === 0 && Math.abs(dx) < MIN_SHIFT && Math.abs(dy) < MIN_SHIFT) continue
    const turn = -l.tilt
    for (const s of l.strokes) {
      const p = rotate({ x: s.transform.x, y: s.transform.y }, l.pivot, turn)
      moves.push({ id: s.id, transform: { ...s.transform, x: p.x + dx, y: p.y + dy, rotation: s.transform.rotation + turn } })
    }
  }
  return moves
}

function measureLine(strokes: InkStroke[]): Line {
  const polys = strokes.map(strokeWorldPoints)
  const bb = boundsOf(polys.flat())
  const pivot = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }
  // short words have too little baseline to measure (same gate as OCR deskew)
  let tilt = polys.length >= 3 || bb.width >= 2 * bb.height ? estimateSkew(polys) : 0
  if (Math.abs(tilt) < MIN_TILT || Math.abs(tilt) > MAX_TILT) tilt = 0
  const straight = polys.flat().map((p) => rotate(p, pivot, -tilt))
  const sb = boundsOf(straight)
  const envelope = lowerEnvelope(straight)
  return {
    strokes,
    pivot,
    tilt,
    baseline: envelope.length ? median(envelope.map((p) => p.y)) : sb.y + sb.height,
    left: sb.x,
  }
}

function rotate(p: Vec2, c: Vec2, angle: number): Vec2 {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}
