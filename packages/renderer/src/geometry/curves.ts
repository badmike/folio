/**
 * Pure 2D path helpers: centripetal Catmull-Rom flattening, orthogonal (elbow)
 * routing and dash splitting. No dependency on the document model.
 */
import type { Vec2 } from '@folio/document'

const EPS = 1e-6

// ---------------------------------------------------------------------------
// Catmull-Rom (centripetal) through a control polyline
// ---------------------------------------------------------------------------

export interface FlatCurve {
  /** Flattened polyline (passes exactly through every control point). */
  path: Vec2[]
  /** Index in `path` of each control point. */
  controlIndex: number[]
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Barry-Goldman evaluation of one centripetal Catmull-Rom segment p1→p2 at u in [0,1]. */
function segmentPoint(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, u: number): Vec2 {
  const knot = (a: Vec2, b: Vec2) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-4)
  const t0 = 0
  const t1 = t0 + knot(p0, p1)
  const t2 = t1 + knot(p1, p2)
  const t3 = t2 + knot(p2, p3)
  const t = t1 + (t2 - t1) * u
  const a1 = lerp(p0, p1, (t - t0) / (t1 - t0))
  const a2 = lerp(p1, p2, (t - t1) / (t2 - t1))
  const a3 = lerp(p2, p3, (t - t2) / (t3 - t2))
  const b1 = lerp(a1, a2, (t - t0) / (t2 - t0))
  const b2 = lerp(a2, a3, (t - t1) / (t3 - t1))
  return lerp(b1, b2, (t - t1) / (t2 - t1))
}

/**
 * Smooth curve through `pts` (>= 2). With exactly two points this is the
 * straight segment. End tangents use reflected ghost points so the curve leaves
 * the first/last point naturally.
 */
export function catmullRom(pts: Vec2[], maxStep = 8): FlatCurve {
  if (pts.length < 2) return { path: pts.slice(), controlIndex: pts.map((_, i) => i) }
  if (pts.length === 2) return { path: [pts[0], pts[1]], controlIndex: [0, 1] }
  const n = pts.length
  const ghost0: Vec2 = { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y }
  const ghostN: Vec2 = { x: 2 * pts[n - 1].x - pts[n - 2].x, y: 2 * pts[n - 1].y - pts[n - 2].y }
  const P = (i: number): Vec2 => (i < 0 ? ghost0 : i >= n ? ghostN : pts[i])
  const path: Vec2[] = [pts[0]]
  const controlIndex = [0]
  for (let i = 0; i < n - 1; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
    const steps = Math.max(8, Math.min(48, Math.ceil(len / maxStep)))
    for (let s = 1; s < steps; s++) path.push(segmentPoint(P(i - 1), P(i), P(i + 1), P(i + 2), s / steps))
    path.push({ x: pts[i + 1].x, y: pts[i + 1].y })
    controlIndex.push(path.length - 1)
  }
  return { path, controlIndex }
}

// ---------------------------------------------------------------------------
// Orthogonal routing
// ---------------------------------------------------------------------------

/** Remove duplicate points and points in the middle of a straight same-direction run. */
export function simplifyOrthogonal(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) continue
    out.push(p)
    while (out.length >= 3) {
      const a = out[out.length - 3], b = out[out.length - 2], c = out[out.length - 1]
      const abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y
      const cross = abx * bcy - aby * bcx
      const dot = abx * bcx + aby * bcy
      if (Math.abs(cross) < EPS && dot > 0) out.splice(out.length - 2, 1) // collinear, same direction
      else break
    }
  }
  return out
}

function dirOf(a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x, dy = b.y - a.y
  const l = Math.hypot(dx, dy) || 1
  return { x: dx / l, y: dy / l }
}

function pathLength(p: Vec2[]): number {
  let l = 0
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)
  return l
}

/**
 * Axis-aligned route from `a` to `b`. `da` is the direction the route must
 * initially not oppose (leaving a shape), `db` the outward direction at `b`
 * (the route must not arrive against it, i.e. it approaches b along -db or
 * perpendicular to it). Returns a polyline whose segments are all horizontal or
 * vertical, starting at a and ending at b.
 */
export function orthogonalRoute(
  a: Vec2, da: Vec2 | null, b: Vec2, db: Vec2 | null, opts: { clearance?: number; firstAxis?: 'h' | 'v' } = {},
): Vec2[] {
  const clearance = opts.clearance ?? 24
  const cands: Vec2[][] = []
  const aligned = Math.abs(a.x - b.x) < EPS || Math.abs(a.y - b.y) < EPS
  if (aligned) cands.push([a, b])
  cands.push([a, { x: b.x, y: a.y }, b], [a, { x: a.x, y: b.y }, b])
  const xs = [(a.x + b.x) / 2, Math.max(a.x, b.x) + clearance, Math.min(a.x, b.x) - clearance]
  const ys = [(a.y + b.y) / 2, Math.max(a.y, b.y) + clearance, Math.min(a.y, b.y) - clearance]
  if (da && Math.abs(da.x) > 0.5) xs.push(a.x + Math.sign(da.x) * clearance)
  if (da && Math.abs(da.y) > 0.5) ys.push(a.y + Math.sign(da.y) * clearance)
  if (db && Math.abs(db.x) > 0.5) xs.push(b.x + Math.sign(db.x) * clearance)
  if (db && Math.abs(db.y) > 0.5) ys.push(b.y + Math.sign(db.y) * clearance)
  for (const mx of xs) cands.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b])
  for (const my of ys) cands.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b])

  let best: Vec2[] | undefined
  let bestScore = Infinity
  for (const raw of cands) {
    const c = simplifyOrthogonal(raw)
    if (c.length < 2) continue
    if (!validRoute(c, da, db)) continue
    let score = pathLength(c) + (c.length - 2) * 20
    if (opts.firstAxis) {
      const horizontal = Math.abs(c[1].y - c[0].y) < EPS
      if ((opts.firstAxis === 'h') !== horizontal) score += 0.5
    }
    if (score < bestScore - 1e-9) { bestScore = score; best = c }
  }
  if (best) return best
  const fallback = simplifyOrthogonal(cands[aligned ? 0 : 1])
  return fallback.length >= 2 ? fallback : [a, b]
}

function validRoute(c: Vec2[], da: Vec2 | null, db: Vec2 | null): boolean {
  if (da) {
    const d = dirOf(c[0], c[1])
    if (d.x * da.x + d.y * da.y < -EPS) return false
  }
  if (db) {
    const d = dirOf(c[c.length - 2], c[c.length - 1])
    if (d.x * db.x + d.y * db.y > EPS) return false
  }
  // reject routes that fold back onto themselves
  for (let i = 1; i + 1 < c.length; i++) {
    const d0 = dirOf(c[i - 1], c[i]), d1 = dirOf(c[i], c[i + 1])
    if (d0.x * d1.x + d0.y * d1.y < -0.5) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Dashes
// ---------------------------------------------------------------------------

/** Dash/gap lengths (world units) for a stroke style; null = solid. Proportional to stroke width. */
export function dashPattern(style: 'solid' | 'dashed' | 'dotted' | undefined, strokeWidth: number): [number, number] | null {
  const w = Math.max(strokeWidth, 1)
  if (style === 'dashed') return [w * 4 + 4, w * 2.5 + 4]
  if (style === 'dotted') return [w * 0.1, w * 2.4 + 1.5]
  return null
}

/** Split a polyline into dash polylines (each with >= 2 points). Phase starts at the first point. */
export function dashPolyline(pts: Vec2[], dash: number, gap: number): Vec2[][] {
  const out: Vec2[][] = []
  if (pts.length < 2 || dash <= 0) return out
  let cur: Vec2[] | null = [pts[0]]
  let remaining = dash
  let drawing = true
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1]
    const b = pts[i]
    let segLen = Math.hypot(b.x - a.x, b.y - a.y)
    while (segLen > 1e-9) {
      if (segLen <= remaining) {
        if (drawing) cur!.push(b)
        remaining -= segLen
        segLen = 0
      } else {
        const t = remaining / segLen
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        if (drawing) {
          cur!.push(p)
          out.push(cur!)
          cur = null
        } else {
          cur = [p]
        }
        drawing = !drawing
        segLen -= remaining
        remaining = drawing ? dash : gap
        a = p
      }
    }
    if (remaining <= 1e-9) {
      // landed exactly on a vertex: flip state
      if (drawing) { if (cur && cur.length >= 2) out.push(cur); cur = null } else cur = [b]
      drawing = !drawing
      remaining = drawing ? dash : gap
    }
  }
  if (drawing && cur && cur.length >= 2) out.push(cur)
  return out.filter((d) => d.length >= 2)
}
