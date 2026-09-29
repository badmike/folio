import type { InkStroke, Rect, Vec2 } from '@folio/document'
import type { StrokeGroup } from './contract'
import {
  boundsOf,
  dist,
  pathLength,
  percentile,
  strokeDuration,
  strokeWorldPoints,
  unionRects,
} from './geometry'

/**
 * Stroke grouping: raw strokes -> (shape candidates) + words -> lines -> blocks.
 *
 *  - Lines: strokes whose vertical extents overlap (tiny strokes such as i-dots get
 *    an expanded extent) and that are horizontally close (<= 3.5 text heights).
 *  - Words: within a line, split at horizontal gaps > 0.55 H (or > 0.25 H when the
 *    pen was lifted for a long time between the strokes, using `startedAt`).
 *  - Blocks: vertically adjacent lines that overlap horizontally or share a left edge.
 *  - Shape candidates: large, closed/straight/simple strokes (optionally with 1-2 small
 *    strokes near an endpoint: arrow head) relative to the text height.
 */

export interface GroupingOptions {
  /** Horizontal gap (in text heights) that separates words. Default 0.55. */
  wordGap?: number
  /** Pen-lift time (ms) that lowers the word-gap threshold. Default 900. */
  slowGapMs?: number
  /** Max time between a shaft and its arrow-head strokes (ms). Default 2500. */
  headWindowMs?: number
  /** Override the text-height reference (world units). */
  textHeight?: number
  /** Minimum absolute diagonal of a shape candidate. Default 40. */
  minShapeSize?: number
}

interface Info {
  s: InkStroke
  pts: Vec2[]
  bb: Rect
  t0: number
  t1: number
}

function info(s: InkStroke): Info {
  const pts = strokeWorldPoints(s)
  return { s, pts, bb: boundsOf(pts), t0: s.startedAt, t1: s.startedAt + strokeDuration(s) }
}

/** Typical text height: 60th percentile of stroke heights (ignores dots/dashes), floor 6. */
export function estimateTextHeight(infos: { bb: Rect }[]): number {
  return Math.max(6, percentile(infos.map((i) => i.bb.height), 0.6))
}

const TEXT_REF_MAX = 48

// ---------------------------------------------------------------------------
// Shape candidates
// ---------------------------------------------------------------------------

function isShapeLike(i: Info, textRef: number, minSize: number): boolean {
  const diag = Math.hypot(i.bb.width, i.bb.height)
  if (diag < Math.max(2 * textRef, minSize)) return false
  const len = pathLength(i.pts)
  if (len === 0) return false
  // Simple (low tortuosity) strokes only: scribbles/cursive have len >> diag.
  return len / diag <= 4
}

function isStraight(pts: Vec2[]): boolean {
  const a = pts[0]
  const b = pts[pts.length - 1]
  const chord = dist(a, b)
  const len = pathLength(pts)
  if (chord === 0 || chord / len < 0.8) return false
  const dx = (b.x - a.x) / chord
  const dy = (b.y - a.y) / chord
  let dev = 0
  for (const p of pts) dev = Math.max(dev, Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx))
  return dev / chord <= 0.1
}

/**
 * Find shape candidates. Returns clusters (1..3 strokes, shaft first) and the
 * remaining strokes (text). Candidates are not verified; run `recognizeShape`.
 */
export function findShapeCandidates(
  strokes: InkStroke[],
  opts: GroupingOptions = {},
): { candidates: InkStroke[][]; rest: InkStroke[] } {
  const infos = strokes.map(info)
  const textRef = Math.min(opts.textHeight ?? estimateTextHeight(infos), TEXT_REF_MAX)
  const minSize = opts.minShapeSize ?? 40
  const headWindow = opts.headWindowMs ?? 2500

  const isCand = new Set(infos.filter((i) => isShapeLike(i, textRef, minSize)).map((i) => i.s.id))
  const used = new Set<string>()
  const candidates: InkStroke[][] = []

  // Largest first so that shafts claim their heads before other candidates do.
  const order = infos.filter((i) => isCand.has(i.s.id)).sort((a, b) => b.bb.width + b.bb.height - (a.bb.width + a.bb.height))
  for (const shaft of order) {
    if (used.has(shaft.s.id)) continue
    used.add(shaft.s.id)
    const cluster = [shaft.s]
    if (isStraight(shaft.pts)) {
      const len = dist(shaft.pts[0], shaft.pts[shaft.pts.length - 1])
      const ends = [shaft.pts[0], shaft.pts[shaft.pts.length - 1]]
      const heads = infos.filter((h) => {
        if (used.has(h.s.id) || h === shaft) return false
        const hd = Math.hypot(h.bb.width, h.bb.height)
        if (hd > 0.45 * len || pathLength(h.pts) > 0.8 * len) return false
        const near = Math.min(...ends.map((e) => Math.min(...h.pts.map((p) => dist(p, e)))))
        if (near > 0.2 * len) return false
        const dt = Math.max(h.t0 - shaft.t1, shaft.t0 - h.t1)
        return dt <= headWindow
      })
      heads
        .sort((a, b) => a.t0 - b.t0)
        .slice(0, 2)
        .forEach((h) => {
          used.add(h.s.id)
          cluster.push(h.s)
        })
    }
    candidates.push(cluster)
  }
  return { candidates, rest: strokes.filter((s) => !used.has(s.id)) }
}

// ---------------------------------------------------------------------------
// Text grouping
// ---------------------------------------------------------------------------

class UnionFind {
  private p: number[]
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i)
  }
  find(x: number): number {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]]
      x = this.p[x]
    }
    return x
  }
  union(a: number, b: number) {
    this.p[this.find(a)] = this.find(b)
  }
}

export interface TextGrouping {
  words: StrokeGroup[]
  lines: StrokeGroup[]
  blocks: StrokeGroup[]
  /** Text height reference used (world units). */
  textHeight: number
}

function makeGroup(items: Info[], kind: StrokeGroup['kind']): StrokeGroup {
  const ordered = [...items].sort((a, b) => a.t0 - b.t0 || a.bb.x - b.bb.x)
  return {
    strokeIds: ordered.map((i) => i.s.id),
    bounds: unionRects(items.map((i) => i.bb)),
    kind,
  }
}

export function groupTextStrokes(strokes: InkStroke[], opts: GroupingOptions = {}): TextGrouping {
  const infos = strokes.map(info)
  const n = infos.length
  if (n === 0) return { words: [], lines: [], blocks: [], textHeight: opts.textHeight ?? 0 }
  const H = opts.textHeight ?? estimateTextHeight(infos)
  const wordGap = opts.wordGap ?? 0.55
  const slowGap = opts.slowGapMs ?? 900

  // --- lines -------------------------------------------------------------
  const uf = new UnionFind(n)
  const extent = (i: Info): [number, number] => {
    if (i.bb.height < 0.45 * H) {
      const cy = i.bb.y + i.bb.height / 2
      return [cy - 0.6 * H, cy + 0.6 * H]
    }
    return [i.bb.y, i.bb.y + i.bb.height]
  }
  const tall = infos.map((i) => i.bb.height > 2.5 * H)
  const ext = infos.map(extent)
  for (let a = 0; a < n; a++) {
    if (tall[a]) continue
    for (let b = a + 1; b < n; b++) {
      if (tall[b]) continue
      const A = infos[a].bb
      const B = infos[b].bb
      const hGap = Math.max(A.x, B.x) - Math.min(A.x + A.width, B.x + B.width)
      if (hGap > 3.5 * H) continue
      const overlap = Math.min(ext[a][1], ext[b][1]) - Math.max(ext[a][0], ext[b][0])
      const minH = Math.min(ext[a][1] - ext[a][0], ext[b][1] - ext[b][0])
      const small = Math.min(infos[a].bb.height, infos[b].bb.height) < 0.45 * H
      // dots / dashes / accents only need to touch the other stroke's extent
      if (small ? overlap > 0.1 * H : overlap >= 0.5 * minH) uf.union(a, b)
    }
  }
  const clusters = new Map<number, Info[]>()
  infos.forEach((it, idx) => {
    const r = uf.find(idx)
    if (!clusters.has(r)) clusters.set(r, [])
    clusters.get(r)!.push(it)
  })

  const lines: { group: StrokeGroup; items: Info[]; H: number }[] = []
  const words: StrokeGroup[] = []
  for (const items of clusters.values()) {
    const lineH = Math.max(6, Math.min(H * 1.5, percentile(items.map((i) => i.bb.height), 0.6)))
    const sorted = [...items].sort((a, b) => a.bb.x - b.bb.x)
    let cur: Info[] = []
    let maxRight = -Infinity
    let lastEnd = -Infinity
    const flush = () => {
      if (cur.length) words.push(makeGroup(cur, 'word'))
      cur = []
    }
    for (const it of sorted) {
      if (cur.length) {
        const gap = it.bb.x - maxRight
        const timeGap = it.t0 - lastEnd
        if (gap > wordGap * lineH || (gap > 0.25 * lineH && timeGap > slowGap)) {
          flush()
          maxRight = -Infinity
        }
      }
      cur.push(it)
      maxRight = Math.max(maxRight, it.bb.x + it.bb.width)
      lastEnd = cur.length === 1 ? it.t1 : Math.max(lastEnd, it.t1)
    }
    flush()
    lines.push({ group: makeGroup(items, 'line'), items, H: lineH })
  }
  lines.sort((a, b) => a.group.bounds.y - b.group.bounds.y || a.group.bounds.x - b.group.bounds.x)
  words.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)

  // --- blocks ------------------------------------------------------------
  const buf = new UnionFind(lines.length)
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      const A = lines[a].group.bounds
      const B = lines[b].group.bounds
      const vGap = B.y - (A.y + A.height)
      const ref = Math.max(lines[a].H, lines[b].H)
      if (vGap > 1.2 * ref) continue
      const hOverlap = Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x)
      const minW = Math.min(A.width, B.width)
      if (hOverlap >= 0.25 * minW || Math.abs(A.x - B.x) <= 2 * ref) buf.union(a, b)
    }
  }
  const blockMap = new Map<number, typeof lines>()
  lines.forEach((l, idx) => {
    const r = buf.find(idx)
    if (!blockMap.has(r)) blockMap.set(r, [])
    blockMap.get(r)!.push(l)
  })
  const blocks: StrokeGroup[] = []
  for (const ls of blockMap.values()) {
    if (ls.length < 2) continue
    blocks.push(makeGroup(ls.flatMap((l) => l.items), 'block'))
  }
  blocks.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)

  return { words, lines: lines.map((l) => l.group), blocks, textHeight: H }
}

/**
 * Full grouping (flat list): shape candidates, then blocks (>= 2 lines), lines and words.
 */
export function groupStrokes(strokes: InkStroke[], opts: GroupingOptions = {}): StrokeGroup[] {
  const alive = strokes.filter((s) => s.points.length >= 6)
  const { candidates, rest } = findShapeCandidates(alive, opts)
  const shapeGroups: StrokeGroup[] = candidates.map((c) => {
    const infos = c.map(info)
    return {
      strokeIds: c.map((s) => s.id),
      bounds: unionRects(infos.map((i) => i.bb)),
      kind: 'shape-candidate' as const,
    }
  })
  const text = groupTextStrokes(rest, opts)
  return [...shapeGroups, ...text.blocks, ...text.lines, ...text.words]
}

