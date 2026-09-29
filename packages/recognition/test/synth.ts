import type { InkStroke } from '@folio/document'
import { makeStroke, polyline, rng } from './helpers'

type P = { x: number; y: number }
type R = ReturnType<typeof rng>

/** Add hand jitter: white noise + smooth low-frequency wobble (both relative to `size`). */
export function jitter(pts: P[], size: number, r: R, level = 1): P[] {
  const sigma = Math.min(0.008 * size, 1.2) * level
  const wob = 0.018 * size * level
  const f1 = r.range(1, 3)
  const f2 = r.range(3, 6)
  const p1 = r.range(0, 6.28)
  const p2 = r.range(0, 6.28)
  const a1 = r.range(-1, 1)
  const a2 = r.range(-1, 1)
  const n = pts.length
  return pts.map((p, i) => {
    const t = i / Math.max(1, n - 1)
    return {
      x: p.x + r.gauss() * sigma + wob * (a1 * Math.sin(6.28 * f1 * t + p1)),
      y: p.y + r.gauss() * sigma + wob * (a2 * Math.sin(6.28 * f2 * t + p2)),
    }
  })
}

/** Start a closed loop at a random place and overshoot / undershoot the closure a bit. */
export function openLoop(loop: P[], r: R): P[] {
  const n = loop.length
  const start = Math.floor(r.range(0, n))
  const rot = loop.slice(start).concat(loop.slice(0, start))
  const extra = Math.floor(r.range(-0.03, 0.07) * n)
  if (extra >= 0) return rot.concat(rot.slice(0, extra))
  return rot.slice(0, n + extra)
}

export function rotatePts(pts: P[], angle: number, c: P): P[] {
  const cs = Math.cos(angle)
  const sn = Math.sin(angle)
  return pts.map((p) => ({ x: c.x + (p.x - c.x) * cs - (p.y - c.y) * sn, y: c.y + (p.x - c.x) * sn + (p.y - c.y) * cn(cs) }))
}
const cn = (c: number) => c

export function rectLoop(w: number, h: number): P[] {
  return polyline([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], true)
}
export function diamondLoop(w: number, h: number): P[] {
  return polyline([{ x: w / 2, y: 0 }, { x: w, y: h / 2 }, { x: w / 2, y: h }, { x: 0, y: h / 2 }], true)
}
export function triangleLoop(w: number, h: number): P[] {
  return polyline([{ x: w / 2, y: 0 }, { x: w, y: h }, { x: 0, y: h }], true)
}
export function ellipseLoop(w: number, h: number): P[] {
  const n = 90
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return { x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a) }
  })
}

export interface Sample {
  label: string
  strokes: InkStroke[]
  expect: string
}

export function generateShapeSamples(seed: number, perKind = 12): Sample[] {
  const r = rng(seed)
  const out: Sample[] = []
  let t0 = 1000
  const stroke = (pts: P[]) => makeStroke(pts, { startedAt: (t0 += 2000) })
  const offset = (pts: P[]) => {
    const ox = r.range(50, 400)
    const oy = r.range(50, 400)
    return pts.map((p) => ({ x: p.x + ox, y: p.y + oy }))
  }
  for (let i = 0; i < perKind; i++) {
    const w = r.range(70, 260)
    const h = r.range(60, 220)
    const size = (w + h) / 2
    const dir = r.next() < 0.5 ? 1 : -1
    const wind = (pts: P[]) => (dir === 1 ? pts : [...pts].reverse())
    const mk = (loop: P[], rot = 0) => {
      const c = { x: w / 2, y: h / 2 }
      const rp = rot ? rotatePts(loop, rot, c) : loop
      return stroke(offset(jitter(openLoop(wind(rp), r), size, r)))
    }
    const rot = r.range(-0.6, 0.6)
    out.push({ label: `rect${i}`, strokes: [mk(rectLoop(w, h))], expect: 'rectangle' })
    out.push({ label: `rectRot${i}`, strokes: [mk(rectLoop(w, h), rot)], expect: 'rectangle' })
    out.push({ label: `ellipse${i}`, strokes: [mk(ellipseLoop(w, h))], expect: 'ellipse' })
    const d = r.range(90, 220)
    out.push({ label: `circle${i}`, strokes: [mk(ellipseLoop(d, d))], expect: 'ellipse' })
    out.push({ label: `tri${i}`, strokes: [mk(triangleLoop(w, h))], expect: 'triangle' })
    out.push({ label: `diamond${i}`, strokes: [mk(diamondLoop(w, h))], expect: 'diamond' })
    // line
    const len = r.range(80, 350)
    const ang = r.range(0, Math.PI * 2)
    const line = polyline([{ x: 0, y: 0 }, { x: Math.cos(ang) * len, y: Math.sin(ang) * len }], false, 4)
    out.push({ label: `line${i}`, strokes: [stroke(offset(jitter(line, len, r, 0.8)))], expect: 'line' })
    // arrows: single stroke with V head (tip -> leg1 -> tip -> leg2) and two-stroke
    const aLen = r.range(100, 320)
    const aAng = r.range(0, Math.PI * 2)
    const dirv = { x: Math.cos(aAng), y: Math.sin(aAng) }
    const norm = { x: -dirv.y, y: dirv.x }
    const tip = { x: dirv.x * aLen, y: dirv.y * aLen }
    const headLen = aLen * r.range(0.14, 0.24)
    const spread = r.range(0.4, 0.7)
    const leg = (s: number) => ({
      x: tip.x - dirv.x * headLen * Math.cos(spread) + s * norm.x * headLen * Math.sin(spread),
      y: tip.y - dirv.y * headLen * Math.cos(spread) + s * norm.y * headLen * Math.sin(spread),
    })
    const shaft = polyline([{ x: 0, y: 0 }, tip], false, 4)
    const single = shaft.concat(polyline([tip, leg(1)], false, 3), polyline([tip, leg(-1)], false, 3))
    out.push({ label: `arrow1_${i}`, strokes: [stroke(offset(jitter(single, aLen, r, 0.5)))], expect: 'arrow' })
    const off = { x: r.range(50, 400), y: r.range(50, 400) }
    const sh = jitter(shaft, aLen, r, 0.8).map((p) => ({ x: p.x + off.x, y: p.y + off.y }))
    const head = jitter(polyline([leg(1), tip, leg(-1)], false, 3), aLen, r, 0.4).map((p) => ({ x: p.x + off.x, y: p.y + off.y }))
    out.push({
      label: `arrow2_${i}`,
      strokes: [makeStroke(sh, { startedAt: (t0 += 2000) }), makeStroke(head, { startedAt: (t0 += 400) })],
      expect: 'arrow',
    })
  }
  return out
}

/** Text-like scribbles that must NOT be recognised as shapes. */
export function generateScribbles(seed: number, n = 24): InkStroke[][] {
  const r = rng(seed)
  const out: InkStroke[][] = []
  for (let i = 0; i < n; i++) {
    const kind = i % 4
    const pts: P[] = []
    const count = 120
    if (kind === 0) {
      // cursive word: sine baseline with loops
      const w = r.range(120, 260)
      for (let k = 0; k < count; k++) {
        const t = k / count
        pts.push({ x: t * w + 14 * Math.sin(t * 40 + i), y: 20 * Math.sin(t * 31 + 1) + 8 * Math.cos(t * 53) })
      }
    } else if (kind === 1) {
      // zig-zag scribble
      for (let k = 0; k < count; k++) {
        const t = k / count
        pts.push({ x: t * 180 + r.range(-4, 4), y: (k % 10 < 5 ? 1 : -1) * r.range(15, 40) })
      }
    } else if (kind === 2) {
      // tight spiral scribble / hatching
      for (let k = 0; k < count; k++) {
        const a = k * 0.55
        pts.push({ x: 60 + (30 + k * 0.4) * Math.cos(a), y: 60 + (30 + k * 0.4) * Math.sin(a) })
      }
    } else {
      // random walk squiggle
      let x = 0
      let y = 0
      for (let k = 0; k < count; k++) {
        x += r.range(-14, 20)
        y += r.range(-18, 18)
        pts.push({ x, y })
      }
    }
    out.push([makeStroke(pts, { startedAt: 1000 * i })])
  }
  return out
}

/**
 * Keep only ~`count` points of a dense path, spaced by (jittered) arc length, like a mouse
 * without coalesced events: the hand speeds up and slows down, and corners are usually cut.
 */
export function sparsify(pts: P[], count: number, r: R): P[] {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  const total = cum[cum.length - 1]
  const out: P[] = [pts[0]]
  let s = 0
  let j = 1
  const mean = total / count
  while (true) {
    s += mean * r.range(0.6, 1.4)
    if (s >= total) break
    while (cum[j] < s) j++
    const t = (s - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1])
    out.push({ x: pts[j - 1].x + t * (pts[j].x - pts[j - 1].x), y: pts[j - 1].y + t * (pts[j].y - pts[j - 1].y) })
  }
  out.push(pts[pts.length - 1])
  return out
}

/** Closed shapes drawn with few samples (12-32 points per stroke). */
export function generateSparseShapeSamples(seed: number, perKind = 12): Sample[] {
  const r = rng(seed)
  const out: Sample[] = []
  let t0 = 1000
  for (let i = 0; i < perKind; i++) {
    const w = r.range(90, 260)
    const h = r.range(70, 220)
    const size = (w + h) / 2
    const ox = r.range(50, 400)
    const oy = r.range(50, 400)
    const dir = r.next() < 0.5 ? 1 : -1
    const mk = (loop: P[], rot = 0) => {
      const c = { x: w / 2, y: h / 2 }
      const rp = rot ? rotatePts(loop, rot, c) : loop
      const dense = jitter(openLoop(dir === 1 ? rp : [...rp].reverse(), r), size, r, 0.7)
      const sparse = sparsify(dense, Math.round(r.range(16, 36)), r)
      return makeStroke(sparse.map((p) => ({ x: p.x + ox, y: p.y + oy })), { startedAt: (t0 += 2000) })
    }
    out.push({ label: `sparseRect${i}`, strokes: [mk(rectLoop(w, h))], expect: 'rectangle' })
    out.push({ label: `sparseRectRot${i}`, strokes: [mk(rectLoop(w, h), r.range(-0.5, 0.5))], expect: 'rectangle' })
    out.push({ label: `sparseEllipse${i}`, strokes: [mk(ellipseLoop(w, h))], expect: 'ellipse' })
    out.push({ label: `sparseTri${i}`, strokes: [mk(triangleLoop(w, h))], expect: 'triangle' })
    out.push({ label: `sparseDiamond${i}`, strokes: [mk(diamondLoop(w, h))], expect: 'diamond' })
  }
  return out
}
