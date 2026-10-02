import type { Rect, Vec2 } from '@folio/document'

/**
 * Snapping for moves, resizes and new shapes: to the edges and centres of other objects,
 * to equal spacing between objects in a row or column, and to the page grid. Per axis the
 * closest object snap wins; the grid applies when no object is in reach.
 */

export interface SnapGuide {
  a: Vec2
  b: Vec2
}

export interface SnapContext {
  /** World bounds of the objects to snap to. */
  targets: Rect[]
  /** Grid spacing (world units) when snapping to the grid. */
  grid?: number
  /** Snap distance (world units). */
  tolerance: number
}

type Axis = 'x' | 'y'

interface Hit {
  delta: number
  /** Guides for the box at its final position. */
  guides: (box: Rect) => SnapGuide[]
}

const start = (r: Rect, a: Axis) => (a === 'x' ? r.x : r.y)
const size = (r: Rect, a: Axis) => (a === 'x' ? r.width : r.height)
const end = (r: Rect, a: Axis) => start(r, a) + size(r, a)
const lines = (r: Rect, a: Axis) => [start(r, a), start(r, a) + size(r, a) / 2, end(r, a)]
const cross = (a: Axis): Axis => (a === 'x' ? 'y' : 'x')
/** A point given its coordinate along `a` and across it. */
const at = (a: Axis, along: number, across: number): Vec2 => (a === 'x' ? { x: along, y: across } : { x: across, y: along })

/** Correction (dx, dy) that snaps a box being moved, plus the guides to show. */
export function snapBox(box: Rect, ctx: SnapContext): { dx: number; dy: number; guides: SnapGuide[] } {
  const hx = closest(align(box, ctx, 'x'), spacing(box, ctx, 'x'))
  const hy = closest(align(box, ctx, 'y'), spacing(box, ctx, 'y'))
  const dx = hx?.delta ?? gridDelta(box.x, ctx.grid)
  const dy = hy?.delta ?? gridDelta(box.y, ctx.grid)
  const moved = { ...box, x: box.x + dx, y: box.y + dy }
  return { dx, dy, guides: [...(hx?.guides(moved) ?? []), ...(hy?.guides(moved) ?? [])] }
}

/** Snap a single point (a dragged handle or a corner of a new shape). */
export function snapPoint(p: Vec2, ctx: SnapContext): { point: Vec2; guides: SnapGuide[] } {
  const box = { x: p.x, y: p.y, width: 0, height: 0 }
  const hx = align(box, ctx, 'x')
  const hy = align(box, ctx, 'y')
  const point = { x: p.x + (hx?.delta ?? gridDelta(p.x, ctx.grid)), y: p.y + (hy?.delta ?? gridDelta(p.y, ctx.grid)) }
  const moved = { ...box, ...point }
  return { point, guides: [...(hx?.guides(moved) ?? []), ...(hy?.guides(moved) ?? [])] }
}

function closest(...hits: (Hit | undefined)[]): Hit | undefined {
  let best: Hit | undefined
  for (const h of hits) if (h && (!best || Math.abs(h.delta) < Math.abs(best.delta))) best = h
  return best
}

/** Edge or centre of the box onto an edge or centre of another object. */
function align(box: Rect, ctx: SnapContext, a: Axis): Hit | undefined {
  let best: { delta: number; line: number; target: Rect } | undefined
  for (const t of ctx.targets) {
    for (const line of lines(t, a)) {
      for (const v of lines(box, a)) {
        const delta = line - v
        if (Math.abs(delta) <= ctx.tolerance && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, line, target: t }
      }
    }
  }
  if (!best) return undefined
  const { delta, line, target } = best
  const c = cross(a)
  return {
    delta,
    guides: (b) => [{
      a: at(a, line, Math.min(start(b, c), start(target, c))),
      b: at(a, line, Math.max(end(b, c), end(target, c))),
    }],
  }
}

/**
 * Equal gaps along `a` between the box and its neighbours in the same row (or column):
 * the gap of any neighbouring pair repeated next to the box, or the middle between the
 * nearest neighbours on both sides.
 */
function spacing(box: Rect, ctx: SnapContext, a: Axis): Hit | undefined {
  const c = cross(a)
  const row = ctx.targets
    .filter((t) => start(t, c) < end(box, c) && end(t, c) > start(box, c))
    .sort((p, q) => start(p, a) - start(q, a))
  if (!row.length) return undefined
  const mid = start(box, a) + size(box, a) / 2
  let before: Rect | undefined
  let after: Rect | undefined
  for (const t of row) {
    if (end(t, a) <= mid && (!before || end(t, a) > end(before, a))) before = t
    if (start(t, a) >= mid && (!after || start(t, a) < start(after, a))) after = t
  }
  const gaps: { from: Rect; to: Rect; gap: number }[] = []
  for (let i = 0; i < row.length; i++) {
    for (let j = i + 1; j < row.length; j++) {
      const gap = start(row[j], a) - end(row[i], a)
      // only direct neighbours: nothing of the row lies between them
      if (gap > 0 && !row.some((t, k) => k !== i && k !== j && start(t, a) >= end(row[i], a) && end(t, a) <= start(row[j], a))) {
        gaps.push({ from: row[i], to: row[j], gap })
      }
    }
  }

  let best: Hit | undefined
  const offer = (pos: number, marks: (b: Rect) => [Rect, Rect][]) => {
    const delta = pos - start(box, a)
    if (Math.abs(delta) > ctx.tolerance || (best && Math.abs(best.delta) <= Math.abs(delta))) return
    best = { delta, guides: (b) => marks(b).flatMap(([p, q]) => gapMarker(p, q, a, ctx.tolerance / 2)) }
  }
  for (const g of gaps) {
    const pair: [Rect, Rect] = [g.from, g.to]
    if (before) offer(end(before, a) + g.gap, (b) => [[before!, b], pair])
    if (after) offer(start(after, a) - g.gap - size(box, a), (b) => [[b, after!], pair])
  }
  if (before && after && start(after, a) - end(before, a) > size(box, a)) {
    offer((end(before, a) + start(after, a) - size(box, a)) / 2, (b) => [[before!, b], [b, after!]])
  }
  return best
}

/** A measuring line across the gap between two boxes along `a`, with end ticks. */
function gapMarker(p: Rect, q: Rect, a: Axis, tick: number): SnapGuide[] {
  const c = cross(a)
  const lo = Math.max(start(p, c), start(q, c))
  const hi = Math.min(end(p, c), end(q, c))
  const mid = lo <= hi ? (lo + hi) / 2 : (start(p, c) + end(p, c) + start(q, c) + end(q, c)) / 4
  const from = end(p, a)
  const to = start(q, a)
  return [
    { a: at(a, from, mid), b: at(a, to, mid) },
    { a: at(a, from, mid - tick), b: at(a, from, mid + tick) },
    { a: at(a, to, mid - tick), b: at(a, to, mid + tick) },
  ]
}

function gridDelta(v: number, grid: number | undefined): number {
  return grid ? Math.round(v / grid) * grid - v : 0
}
