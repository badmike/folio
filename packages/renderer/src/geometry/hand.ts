/**
 * A drawing hand for themes with hand levels (see HandProfile): polygon outlines drawn edge
 * by edge (bowed, running past the corners, corners slightly off) and marker strokes whose
 * width varies along the line like a felt pen. Deterministic per seed, so shapes never
 * change between frames or devices.
 */
import type { HandProfile, Vec2 } from '@folio/document'

/** Small seeded PRNG (mulberry32), 0..1. */
export function seeded(seed: number): () => number {
  let a = (Math.floor(Math.abs(seed)) * 2654435761) >>> 0 || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Whether the profile draws polygon outlines edge by edge. */
export function drawsEdges(p: HandProfile | null): p is HandProfile {
  return !!p && (p.overshoot > 0 || p.bow > 0 || p.skew > 0)
}

/**
 * A closed polygon as the hand draws it: `corners` (moved by up to `skew`) for the fill, and
 * one open stroke per edge, bowed and extended past its corners.
 */
export function handPolygon(vertices: Vec2[], p: HandProfile, seed: number): { corners: Vec2[]; edges: Vec2[][] } {
  const rnd = seeded(seed)
  const j = () => (rnd() * 2 - 1) * p.skew
  const corners = vertices.map((v) => ({ x: v.x + j(), y: v.y + j() }))
  const n = corners.length
  // at each corner only one of the two edges runs past it; the other just about meets it
  const long = corners.map(() => p.overshoot * (0.4 + 0.6 * rnd()))
  const short = corners.map(() => p.overshoot * 0.15 * rnd())
  const leaving = corners.map(() => rnd() < 0.5)
  const edges: Vec2[][] = []
  for (let i = 0; i < n; i++) {
    const a = corners[i], b = corners[(i + 1) % n]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1e-6) continue
    const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len
    const k = (i + 1) % n
    const before = leaving[i] ? long[i] : short[i]
    const after = leaving[k] ? short[k] : long[k]
    const s = { x: a.x - dx * before, y: a.y - dy * before }
    const e = { x: b.x + dx * after, y: b.y + dy * after }
    const bow = (rnd() * 2 - 1) * p.bow * len
    // the bow peaks a little off centre
    const peak = 0.35 + rnd() * 0.3
    const steps = Math.max(6, Math.min(40, Math.round(len / 10)))
    const line: Vec2[] = []
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      const off = bow * (t < peak ? t / peak : (1 - t) / (1 - peak)) ** 0.8
      line.push({ x: s.x + (e.x - s.x) * t - dy * off, y: s.y + (e.y - s.y) * t + dx * off })
    }
    edges.push(line)
  }
  return { corners, edges }
}

const POINTS_PER_PIECE = 48

/**
 * Outline polygons of a marker stroke along `line`: the width wanders by `jitter` (low
 * frequency, like pen pressure) and the ends are rounded. Long strokes come back in
 * overlapping pieces so every polygon stays simple.
 */
export function markerOutline(line: Vec2[], width: number, jitter: number, seed: number): Vec2[][] {
  const pts = resample(line, Math.max(1.5, width * 0.6))
  if (pts.length < 2) return []
  const rnd = seeded(seed)
  const p1 = rnd() * 10, p2 = rnd() * 10
  const half: number[] = []
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    if (i) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    const n = Math.sin(s * 0.035 + p1) * 0.6 + Math.sin(s * 0.11 + p2) * 0.4
    half.push((width / 2) * (1 + jitter * n))
  }
  const out: Vec2[][] = []
  for (let start = 0; start < pts.length - 1; start += POINTS_PER_PIECE) {
    const end = Math.min(pts.length - 1, start + POINTS_PER_PIECE)
    out.push(ribbon(pts, half, start, end, start === 0, end === pts.length - 1))
  }
  return out
}

/** Polygon around pts[from..to] with half-widths `half`; `capStart` / `capEnd` round the ends. */
function ribbon(pts: Vec2[], half: number[], from: number, to: number, capStart: boolean, capEnd: boolean): Vec2[] {
  const left: Vec2[] = [], right: Vec2[] = []
  const normal = (i: number): Vec2 => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l }
  }
  for (let i = from; i <= to; i++) {
    const n = normal(i)
    left.push({ x: pts[i].x + n.x * half[i], y: pts[i].y + n.y * half[i] })
    right.push({ x: pts[i].x - n.x * half[i], y: pts[i].y - n.y * half[i] })
  }
  const cap = (i: number, sign: 1 | -1): Vec2[] => {
    const n = normal(i)
    const ang = Math.atan2(n.y, n.x)
    const arc: Vec2[] = []
    for (let k = 1; k < 6; k++) {
      const a = ang + sign * (Math.PI * k) / 6
      arc.push({ x: pts[i].x + Math.cos(a) * half[i], y: pts[i].y + Math.sin(a) * half[i] })
    }
    return arc
  }
  // left forward, end cap, right backward, start cap
  return [...left, ...(capEnd ? cap(to, -1) : []), ...right.reverse(), ...(capStart ? cap(from, 1).reverse() : [])]
}

/** Points along a polyline at roughly even `step` spacing (keeps the original corners). */
function resample(line: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [line[0]]
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i]
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.max(1, Math.ceil(d / step))
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })
  }
  return out
}

/** Dots of a halftone print inside `poly`: a grid rotated by `angle` degrees, `spacing` apart, `radius` each. */
export function halftone(poly: Vec2[], spacing: number, radius: number, angle: number): Vec2[][] {
  if (poly.length < 3 || radius <= 0) return []
  const a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y) }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, reach = Math.hypot(x1 - x0, y1 - y0) / 2
  const steps = 8
  const dots: Vec2[][] = []
  for (let u = -reach; u <= reach; u += spacing) {
    for (let v = -reach; v <= reach; v += spacing) {
      const c = { x: cx + u * ca - v * sa, y: cy + u * sa + v * ca }
      if (!inside(c, poly)) continue
      const dot: Vec2[] = []
      for (let k = 0; k < steps; k++) dot.push({ x: c.x + Math.cos((k / steps) * Math.PI * 2) * radius, y: c.y + Math.sin((k / steps) * Math.PI * 2) * radius })
      dots.push(dot)
    }
  }
  return dots
}

/**
 * Watercolour layers over `poly`: a few translucent copies whose edges wander in and out by
 * up to `bleed`, so the paint pools darker where they overlap and bleeds unevenly at the rim.
 */
export function washLayers(poly: Vec2[], bleed: number, seed: number, layers = 3): Vec2[][] {
  const ring = resample([...poly, poly[0]], Math.max(3, bleed)).slice(0, -1)
  if (ring.length < 3) return [poly]
  const out: Vec2[][] = []
  for (let l = 0; l < layers; l++) {
    const rnd = seeded(seed + l * 101)
    const p1 = rnd() * 10, p2 = rnd() * 10
    // later layers sit a little inside and off-centre, like paint that dried before the next pass
    const inset = (l / layers) * bleed * 0.8
    const dx = (rnd() - 0.5) * bleed, dy = (rnd() - 0.5) * bleed
    const layer: Vec2[] = []
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i - 1 + ring.length) % ring.length], b = ring[(i + 1) % ring.length]
      const l2 = Math.hypot(b.x - a.x, b.y - a.y) || 1
      // outward normal for either winding: towards the outside of the polygon
      let nx = (b.y - a.y) / l2, ny = (a.x - b.x) / l2
      if (inside({ x: ring[i].x + nx, y: ring[i].y + ny }, poly)) { nx = -nx; ny = -ny }
      const t = i / ring.length
      const wander = (Math.sin(t * Math.PI * 2 * 3 + p1) * 0.6 + Math.sin(t * Math.PI * 2 * 7 + p2) * 0.4) * bleed
      const d = wander - inset
      layer.push({ x: ring[i].x + nx * d + dx, y: ring[i].y + ny * d + dy })
    }
    out.push(layer)
  }
  return out
}

function inside(p: Vec2, poly: Vec2[]): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}
