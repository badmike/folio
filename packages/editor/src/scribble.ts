import { INK_POINT_STRIDE } from '@folio/document'
import type { InkStroke, Vec2 } from '@folio/document'
import { localToWorld, pointInPolygon } from './geometry'

/**
 * Scribble to erase: a dense back-and-forth pen stroke over existing ink deletes that ink.
 * The gesture test is geometric only. The editor also requires the scribble to cover ink,
 * so zigzag handwriting in empty space stays ink.
 */

/** Direction changes a scribble needs along one of its axes. */
const MIN_REVERSALS = 4
/** A leg has to travel this share of the scribble's extent on that axis to count. */
const LEG_SHARE = 0.4
/** Path length per diagonal of the scribble's oriented box: separates scribbles from most cursive. */
const MIN_DENSITY = 2.5
/** Share of a stroke that has to lie inside the scribble to be erased. */
const MIN_COVER = 0.6
const COVER_SAMPLES = 48

/** Outline (convex hull, world space) of `world` ([x,y,pressure,tiltX,tiltY,t] * n) when it is a scribble. */
export function scribbleHull(world: number[]): Vec2[] | undefined {
  const pts: Vec2[] = []
  for (let i = 0; i + 1 < world.length; i += INK_POINT_STRIDE) pts.push({ x: world[i], y: world[i + 1] })
  if (pts.length < 16) return undefined

  // principal axes, so diagonal scribbles count like horizontal ones
  let mx = 0, my = 0
  for (const p of pts) { mx += p.x; my += p.y }
  mx /= pts.length
  my /= pts.length
  let xx = 0, xy = 0, yy = 0
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my
    xx += dx * dx; xy += dx * dy; yy += dy * dy
  }
  const a = 0.5 * Math.atan2(2 * xy, xx - yy)
  const c = Math.cos(a), s = Math.sin(a)
  const u = pts.map((p) => p.x * c + p.y * s)
  const v = pts.map((p) => p.y * c - p.x * s)

  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  const ru = range(u), rv = range(v)
  const diag = Math.hypot(ru, rv)
  if (diag === 0 || len / diag < MIN_DENSITY) return undefined
  if (reversals(u, LEG_SHARE * ru) < MIN_REVERSALS && reversals(v, LEG_SHARE * rv) < MIN_REVERSALS) return undefined
  return convexHull(pts)
}

/** True when most of the stroke lies inside the scribble outline. */
export function scribbleCovers(stroke: InkStroke, hull: Vec2[]): boolean {
  const n = Math.floor(stroke.points.length / INK_POINT_STRIDE)
  if (!n) return false
  const step = Math.max(1, Math.floor(n / COVER_SAMPLES))
  let inside = 0, total = 0
  for (let i = 0; i < n; i += step) {
    const o = i * INK_POINT_STRIDE
    total++
    if (pointInPolygon(localToWorld(stroke.transform, { x: stroke.points[o], y: stroke.points[o + 1] }), hull)) inside++
  }
  return inside >= MIN_COVER * total
}

function range(xs: number[]): number {
  let lo = Infinity, hi = -Infinity
  for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x }
  return hi - lo
}

/** Direction changes along one axis, ignoring wobble smaller than `h`. */
function reversals(xs: number[], h: number): number {
  if (!(h > 0)) return 0
  let dir = 0, lo = xs[0], hi = xs[0], ext = xs[0], count = 0
  for (const x of xs) {
    if (dir === 0) {
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
      if (x - lo > h) { dir = 1; ext = x } else if (hi - x > h) { dir = -1; ext = x }
    } else if (dir * (x - ext) > 0) {
      ext = x
    } else if (Math.abs(x - ext) > h) {
      dir = -dir
      ext = x
      count++
    }
  }
  return count
}

/** Convex hull (monotone chain). */
function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y)
  const cross = (o: Vec2, p: Vec2, q: Vec2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)
  const half = (list: Vec2[]) => {
    const out: Vec2[] = []
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  return [...half(pts), ...half(pts.reverse())]
}
