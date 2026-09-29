import type { InkStroke, Vec2 } from '@folio/document'
import type { ShapeMatch } from './contract'
import {
  boundsOf,
  clamp01,
  convexHull,
  dist,
  distToPolyline,
  distToSegment,
  pathLength,
  polygonPerimeter,
  resample,
  strokeWorldPoints,
} from './geometry'

/**
 * Algorithmic shape recognizer (no ML).
 *
 * Pipeline (per stroke or stroke cluster):
 *   resample -> closure/straightness metrics -> template fits
 *   open   : line | arrow (single stroke with hook, or shaft + head strokes)
 *   closed : ellipse | rectangle | diamond | triangle (lowest normalised outline error wins)
 * Text-like squiggles (long path relative to the hull, no dominant template) yield null.
 *
 * Output convention for closed shapes: `bounds` is the UNROTATED box (width/height)
 * centred on the shape centre; `rotation` (radians) rotates it about that centre.
 * For line/arrow `points` = [start, end] (arrow: end = head tip).
 */

export const SHAPE_RECOGNIZER_ID = 'shape@1'

export interface ShapeOptions {
  /** Ignore ink whose bounding-box diagonal is smaller than this (world units). */
  minSize?: number
}

const N = 64
/** Normalised outline error above which a closed fit is rejected. */
const MAX_FIT_ERR = 0.075
/** Path/hull-perimeter ratio above which a closed stroke is treated as scribble. */
const MAX_SCRIBBLE_RATIO = 1.45

export function recognizeShape(strokes: InkStroke[], opts: ShapeOptions = {}): ShapeMatch | null {
  const minSize = opts.minSize ?? 24
  const ordered = [...strokes].sort((a, b) => a.startedAt - b.startedAt)
  const polys = ordered.map(strokeWorldPoints).map(dedupe).filter((p) => p.length >= 2)
  if (polys.length === 0 || polys.length > 3) return null

  if (polys.length === 1) return recognizeSingle(polys[0], minSize)

  // Multi-stroke: arrow (shaft + head strokes) first, otherwise try joining consecutive strokes.
  const arrow = recognizeShaftAndHead(polys, minSize)
  if (arrow) return arrow
  const joined = joinConsecutive(polys)
  return joined ? recognizeSingle(joined, minSize) : null
}

// ---------------------------------------------------------------------------
// Single stroke
// ---------------------------------------------------------------------------

function recognizeSingle(raw: Vec2[], minSize: number): ShapeMatch | null {
  const pts = smooth(normalizeSampling(raw))
  const bb = boundsOf(pts)
  const diag = Math.hypot(bb.width, bb.height)
  if (diag < minSize) return null
  const len = pathLength(pts)
  if (len === 0) return null

  const gap = dist(pts[0], pts[pts.length - 1])
  const openness = gap / len

  if (openness > 0.2) {
    return recognizeLine(pts, len) ?? recognizeHookArrow(pts, minSize)
  }
  return recognizeClosed(pts, len, openness)
}

/** Max perpendicular deviation of pts from the chord start->end, and chord length. */
function chordDeviation(pts: Vec2[]): { dev: number; chord: number } {
  const a = pts[0]
  const b = pts[pts.length - 1]
  const chord = dist(a, b)
  if (chord === 0) return { dev: Infinity, chord }
  let dev = 0
  const dx = (b.x - a.x) / chord
  const dy = (b.y - a.y) / chord
  for (const p of pts) dev = Math.max(dev, Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx))
  return { dev, chord }
}

function recognizeLine(pts: Vec2[], len: number): ShapeMatch | null {
  const { dev, chord } = chordDeviation(pts)
  if (chord / len < 0.8) return null
  const ratio = dev / chord
  if (ratio > 0.07) return null
  const a = pts[0]
  const b = pts[pts.length - 1]
  return {
    shape: 'line',
    confidence: clamp01(0.55 + 0.45 * (1 - ratio / 0.07)),
    bounds: boundsOf([a, b]),
    rotation: Math.atan2(b.y - a.y, b.x - a.x),
    points: [{ ...a }, { ...b }],
  }
}

/** A single stroke: straight shaft to the tip, then back along one or both head legs. */
function recognizeHookArrow(pts: Vec2[], minSize: number): ShapeMatch | null {
  const start = pts[0]
  let tipIdx = 0
  let far = 0
  for (let i = 0; i < pts.length; i++) {
    const d = dist(pts[i], start)
    if (d > far) {
      far = d
      tipIdx = i
    }
  }
  if (tipIdx < 2 || tipIdx >= pts.length - 1) return null
  const tip = pts[tipIdx]
  const shaft = pts.slice(0, tipIdx + 1)
  const shaftLen = far
  if (shaftLen < minSize) return null
  const { dev } = chordDeviation(shaft)
  if (dev / shaftLen > 0.08 || pathLength(shaft) / shaftLen > 1.3) return null

  const head = analyseHead(start, tip, [pts.slice(tipIdx)])
  if (!head) return null
  const straightness = 1 - clamp01(dev / shaftLen / 0.08)
  return arrowMatch(start, tip, clamp01(0.62 + 0.18 * straightness + (head.bothSides ? 0.15 : 0)))
}

interface HeadInfo {
  bothSides: boolean
}

/**
 * Check that `headPolys` form an arrow head at `tip` of the shaft start->tip:
 * they stay behind the tip, have a plausible size and spread laterally.
 */
function analyseHead(start: Vec2, tip: Vec2, headPolys: Vec2[][]): HeadInfo | null {
  const L = dist(start, tip)
  const dx = (tip.x - start.x) / L
  const dy = (tip.y - start.y) / L
  let maxBack = 0
  let minLat = 0
  let maxLat = 0
  let total = 0
  for (const poly of headPolys) {
    total += pathLength(poly)
    for (const p of poly) {
      const back = (tip.x - p.x) * dx + (tip.y - p.y) * dy // >0 = behind the tip
      const lat = (p.x - tip.x) * -dy + (p.y - tip.y) * dx
      if (back < -0.08 * L) return null // head sticks out beyond the tip
      maxBack = Math.max(maxBack, back)
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
    }
  }
  if (maxBack < 0.06 * L || maxBack > 0.5 * L) return null
  if (Math.max(maxLat, -minLat) < 0.04 * L) return null
  if (total > 1.2 * L) return null
  const sideThreshold = 0.03 * L
  return { bothSides: minLat < -sideThreshold && maxLat > sideThreshold }
}

function arrowMatch(start: Vec2, tip: Vec2, confidence: number): ShapeMatch {
  return {
    shape: 'arrow',
    confidence: clamp01(confidence),
    bounds: boundsOf([start, tip]),
    rotation: Math.atan2(tip.y - start.y, tip.x - start.x),
    points: [{ ...start }, { ...tip }],
  }
}

/** Longest stroke = shaft; remaining 1-2 strokes = head near one endpoint. */
function recognizeShaftAndHead(polys: Vec2[][], minSize: number): ShapeMatch | null {
  let si = 0
  for (let i = 1; i < polys.length; i++) if (pathLength(polys[i]) > pathLength(polys[si])) si = i
  const shaft = polys[si]
  const heads = polys.filter((_, i) => i !== si)
  const sLen = pathLength(shaft)
  const { dev, chord } = chordDeviation(shaft)
  if (chord < minSize || chord / sLen < 0.8 || dev / chord > 0.08) return null

  const a = shaft[0]
  const b = shaft[shaft.length - 1]
  // Pick the endpoint the head strokes are attached to.
  const nearest = (e: Vec2) => Math.min(...heads.map((h) => Math.min(...h.map((p) => dist(p, e)))))
  const atEnd = nearest(b) <= nearest(a)
  const tip = atEnd ? b : a
  const tail = atEnd ? a : b
  if (nearest(tip) > 0.2 * chord) return null
  // A head stroke should be a small V/hook, not a second long stroke.
  for (const h of heads) if (pathLength(h) > 0.7 * chord) return null

  const info = analyseHead(tail, tip, heads)
  if (!info) return null
  const straightness = 1 - clamp01(dev / chord / 0.08)
  const touch = 1 - clamp01(nearest(tip) / (0.2 * chord))
  return arrowMatch(tail, tip, 0.6 + 0.15 * straightness + 0.1 * touch + (info.bothSides || heads.length > 1 ? 0.15 : 0))
}

/** Concatenate strokes end-to-start when each next stroke begins near the previous end. */
function joinConsecutive(polys: Vec2[][]): Vec2[] | null {
  const out = [...polys[0]]
  const size = Math.hypot(boundsOf(polys.flat()).width, boundsOf(polys.flat()).height)
  for (let i = 1; i < polys.length; i++) {
    if (dist(out[out.length - 1], polys[i][0]) > 0.2 * size) return null
    out.push(...polys[i])
  }
  return out
}

// ---------------------------------------------------------------------------
// Closed shapes
// ---------------------------------------------------------------------------

interface Fit {
  shape: 'ellipse' | 'rectangle' | 'diamond' | 'triangle'
  err: number
  cx: number
  cy: number
  w: number
  h: number
  rotation: number
}

function recognizeClosed(pts: Vec2[], len: number, openness: number): ShapeMatch | null {
  const r = resample(pts, N)
  const hull = convexHull(r)
  if (hull.length < 3) return null
  if (len / polygonPerimeter(hull) > MAX_SCRIBBLE_RATIO) return null
  if (Math.abs(netTurning(r)) < 1.1 * Math.PI) return null

  const fits: Fit[] = []
  const ell = fitEllipse(r)
  if (ell) fits.push(ell)
  const rect = fitRectangle(r)
  fits.push(rect)
  const dia = fitDiamond(r)
  fits.push(dia)
  const bestSoFar = Math.min(...fits.map((f) => f.err))
  if (bestSoFar > 0.025) {
    const tri = fitTriangle(r)
    if (tri) fits.push(tri)
  }

  // A circle is inherently only ~0.05 away from its bounding square, so the ellipse gets a bias.
  const scored = fits.map((f) => ({ f, score: f.shape === 'ellipse' ? f.err / 1.25 : f.err }))
  let best = scored.reduce((a, b) => (b.score < a.score ? b : a)).f
  // A square/rect rotated ~45deg is ambiguous with a diamond: prefer the diamond
  // (the user's intent, and it needs no rotation) unless the rectangle is clearly better.
  if (best.shape === 'rectangle' && Math.abs(best.rotation) >= (30 * Math.PI) / 180 && dia.err <= best.err + 0.02) {
    best = dia
  }
  if (best.err > MAX_FIT_ERR) return null

  const fitQuality = 1 - clamp01(best.err / 0.12)
  const closure = 1 - 0.35 * clamp01(openness / 0.2)
  const confidence = clamp01(fitQuality * closure * 1.05)
  return {
    shape: best.shape === 'ellipse' ? 'ellipse' : best.shape,
    confidence,
    bounds: { x: best.cx - best.w / 2, y: best.cy - best.h / 2, width: best.w, height: best.h },
    rotation: best.rotation,
  }
}

/** Sum of signed turning angles along the path (radians). */
function netTurning(pts: Vec2[]): number {
  let sum = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const a1 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x)
    const a2 = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x)
    let d = a2 - a1
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    sum += d
  }
  return sum
}

function fitEllipse(r: Vec2[]): Fit | null {
  const n = r.length
  let cx = 0
  let cy = 0
  for (const p of r) {
    cx += p.x
    cy += p.y
  }
  cx /= n
  cy /= n
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const p of r) {
    const x = p.x - cx
    const y = p.y - cy
    sxx += x * x
    syy += y * y
    sxy += x * y
  }
  const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy) // major axis direction
  const c = Math.cos(phi)
  const s = Math.sin(phi)
  // Least squares for p = 1/a^2, q = 1/b^2 in the principal frame: p u^2 + q v^2 = 1.
  let u4 = 0
  let v4 = 0
  let u2v2 = 0
  let u2 = 0
  let v2 = 0
  const uv: Vec2[] = []
  for (const pt of r) {
    const x = pt.x - cx
    const y = pt.y - cy
    const u = x * c + y * s
    const v = -x * s + y * c
    uv.push({ x: u, y: v })
    u4 += u ** 4
    v4 += v ** 4
    u2v2 += u * u * v * v
    u2 += u * u
    v2 += v * v
  }
  const det = u4 * v4 - u2v2 * u2v2
  if (Math.abs(det) < 1e-9) return null
  const p = (u2 * v4 - v2 * u2v2) / det
  const q = (u4 * v2 - u2v2 * u2) / det
  if (p <= 0 || q <= 0) return null
  const a = 1 / Math.sqrt(p)
  const b = 1 / Math.sqrt(q)
  let errSum = 0
  for (const { x: u, y: v } of uv) {
    const rr = Math.sqrt(u * u * p + v * v * q)
    const rad = Math.hypot(u, v)
    errSum += rr > 1e-9 ? Math.abs(rr - 1) * (rad / rr) : Math.min(a, b)
  }
  const err = errSum / n / ((a + b) / 2)

  let rotation = phi
  let w = 2 * a
  let h = 2 * b
  if (Math.max(a, b) / Math.min(a, b) < 1.12) {
    // circle
    w = h = a + b
    rotation = 0
  } else {
    // normalise rotation into (-pi/2, pi/2] and snap to axis-aligned when close
    while (rotation > Math.PI / 2) rotation -= Math.PI
    while (rotation <= -Math.PI / 2) rotation += Math.PI
    if (Math.abs(rotation) < 0.12) rotation = 0
    else if (Math.abs(rotation) > Math.PI / 2 - 0.12) {
      rotation = 0
      ;[w, h] = [h, w]
    }
  }
  return { shape: 'ellipse', err, cx, cy, w, h, rotation }
}

/** Frame with u axis (cos t, sin t), v axis (-sin t, cos t). */
function toFrame(pts: Vec2[], t: number): Vec2[] {
  const c = Math.cos(t)
  const s = Math.sin(t)
  return pts.map((p) => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c }))
}

function fromFrame(u: number, v: number, t: number): Vec2 {
  const c = Math.cos(t)
  const s = Math.sin(t)
  return { x: u * c - v * s, y: u * s + v * c }
}

function extents(q: Vec2[]) {
  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  for (const p of q) {
    minU = Math.min(minU, p.x)
    maxU = Math.max(maxU, p.x)
    minV = Math.min(minV, p.y)
    maxV = Math.max(maxV, p.y)
  }
  return { minU, maxU, minV, maxV }
}

function rectError(q: Vec2[], e: ReturnType<typeof extents>): number {
  let sum = 0
  for (const p of q) {
    sum += Math.min(p.x - e.minU, e.maxU - p.x, p.y - e.minV, e.maxV - p.y)
  }
  const w = e.maxU - e.minU
  const h = e.maxV - e.minV
  return sum / q.length / ((w + h) / 2)
}

function fitRectangle(r: Vec2[]): Fit {
  // Minimum-area oriented bounding box (coarse then fine search over 0..90deg).
  const area = (t: number) => {
    const e = extents(toFrame(r, t))
    return (e.maxU - e.minU) * (e.maxV - e.minV)
  }
  let bestT = 0
  let bestA = Infinity
  for (let d = 0; d < 90; d += 2) {
    const a = area((d * Math.PI) / 180)
    if (a < bestA) {
      bestA = a
      bestT = d
    }
  }
  for (let d = bestT - 2; d <= bestT + 2; d += 0.25) {
    const a = area((d * Math.PI) / 180)
    if (a < bestA) {
      bestA = a
      bestT = d
    }
  }
  let t = (bestT * Math.PI) / 180
  // normalise to (-45deg, 45deg]; extents are re-measured in the chosen frame below
  if (t > Math.PI / 4) t -= Math.PI / 2
  if (Math.abs(t) < (5 * Math.PI) / 180) t = 0
  const q = toFrame(r, t)
  const e = extents(q)
  const err = rectError(q, e)
  const w = e.maxU - e.minU
  const h = e.maxV - e.minV
  const c = fromFrame((e.minU + e.maxU) / 2, (e.minV + e.maxV) / 2, t)
  return { shape: 'rectangle', err, cx: c.x, cy: c.y, w, h, rotation: t }
}

function diamondPoly(cx: number, cy: number, w: number, h: number): Vec2[] {
  return [
    { x: cx, y: cy - h / 2 },
    { x: cx + w / 2, y: cy },
    { x: cx, y: cy + h / 2 },
    { x: cx - w / 2, y: cy },
  ]
}

function fitDiamond(r: Vec2[]): Fit {
  let best: Fit | null = null
  for (let d = -15; d <= 15; d += 5) {
    const t = (d * Math.PI) / 180
    const q = toFrame(r, t)
    const e = extents(q)
    const w = e.maxU - e.minU
    const h = e.maxV - e.minV
    const cu = (e.minU + e.maxU) / 2
    const cv = (e.minV + e.maxV) / 2
    const poly = diamondPoly(cu, cv, w, h)
    let sum = 0
    for (const p of q) sum += distToPolyline(p, poly, true)
    const err = sum / q.length / ((w + h) / 2) + Math.abs(d) * 0.0004 // tiny bias towards upright
    if (!best || err < best.err) {
      const c = fromFrame(cu, cv, t)
      best = { shape: 'diamond', err, cx: c.x, cy: c.y, w, h, rotation: d === 0 ? 0 : t }
    }
  }
  return best!
}

function triangleTemplate(apex: Vec2, b1: Vec2, b2: Vec2): { poly: Vec2[]; rotation: number; w: number; h: number; c: Vec2 } {
  const mid = { x: (b1.x + b2.x) / 2, y: (b1.y + b2.y) / 2 }
  const w = dist(b1, b2)
  // unit normal of the base pointing towards the apex
  const bx = (b2.x - b1.x) / w
  const by = (b2.y - b1.y) / w
  let nx = -by
  let ny = bx
  if ((apex.x - mid.x) * nx + (apex.y - mid.y) * ny < 0) {
    nx = -nx
    ny = -ny
  }
  const h = Math.abs((apex.x - b1.x) * nx + (apex.y - b1.y) * ny)
  // local up (0,-1) rotated by theta = (sin t, -cos t) must equal (nx, ny)
  const rotation = Math.atan2(nx, -ny)
  const tApex = { x: mid.x + nx * h, y: mid.y + ny * h }
  const c = { x: mid.x + (nx * h) / 2, y: mid.y + (ny * h) / 2 }
  return { poly: [tApex, b2, b1], rotation, w, h, c }
}

function fitTriangle(r: Vec2[]): Fit | null {
  // Search over vertex triples of a coarse subsample, then evaluate with template apex.
  const m = 40
  const s = resample(r, m)
  let bestErr = Infinity
  let bestTri: [number, number, number] | null = null
  const evalTri = (i: number, j: number, k: number) => {
    const A = s[i]
    const B = s[j]
    const C = s[k]
    let sum = 0
    for (const p of s) {
      sum += Math.min(distToSegment(p, A, B), distToSegment(p, B, C), distToSegment(p, C, A))
    }
    return sum / s.length
  }
  for (let i = 0; i < m; i++)
    for (let j = i + 1; j < m; j++)
      for (let k = j + 1; k < m; k++) {
        const e = evalTri(i, j, k)
        if (e < bestErr) {
          bestErr = e
          bestTri = [i, j, k]
        }
      }
  if (!bestTri) return null
  const V = bestTri.map((i) => s[i])
  // reject slivers / corner angles < 20deg
  for (let i = 0; i < 3; i++) {
    const a = V[i]
    const b = V[(i + 1) % 3]
    const c = V[(i + 2) % 3]
    const ang = Math.abs(
      Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(c.y - a.y, c.x - a.x),
    )
    const inner = Math.min(ang, 2 * Math.PI - ang)
    if (inner < (20 * Math.PI) / 180) return null
  }

  let best: Fit | null = null
  for (let apexI = 0; apexI < 3; apexI++) {
    const tpl = triangleTemplate(V[apexI], V[(apexI + 1) % 3], V[(apexI + 2) % 3])
    if (tpl.w < 1 || tpl.h < 1) continue
    let sum = 0
    for (const p of r) sum += distToPolyline(p, tpl.poly, true)
    const err = sum / r.length / ((tpl.w + tpl.h) / 2) + 0.01 * (Math.abs(tpl.rotation) / Math.PI)
    if (!best || err < best.err) {
      best = { shape: 'triangle', err, cx: tpl.c.x, cy: tpl.c.y, w: tpl.w, h: tpl.h, rotation: tpl.rotation }
    }
  }
  if (!best) return null
  if (Math.abs(best.rotation) < 0.14) best.rotation = 0
  return best
}

/** Target spacing (as a fraction of path length) that sparse input is resampled to. */
const DENSE_POINTS = 96

/**
 * Make the sampling density independent of the input device. Mouse input without coalesced
 * events yields a handful of points per side; smoothing / metrics tuned for dense pen data would
 * then round corners off. Sparse strokes are resampled uniformly by arc length so the (fixed
 * window) smoothing and all later stages see comparable data. Dense input is left untouched.
 */
function normalizeSampling(pts: Vec2[]): Vec2[] {
  if (pts.length >= DENSE_POINTS) return pts
  return resample(pts, DENSE_POINTS)
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = []
  for (const p of pts) {
    const l = out[out.length - 1]
    if (!l || l.x !== p.x || l.y !== p.y) out.push(p)
  }
  return out
}

/** Light moving-average smoothing (endpoints kept) so sensor jitter does not inflate path lengths. */
function smooth(pts: Vec2[], k = 2): Vec2[] {
  if (pts.length < 2 * k + 2) return pts
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p
    const r = Math.min(k, i, pts.length - 1 - i)
    let x = 0
    let y = 0
    for (let j = i - r; j <= i + r; j++) {
      x += pts[j].x
      y += pts[j].y
    }
    const c = 2 * r + 1
    return { x: x / c, y: y / c }
  })
}
