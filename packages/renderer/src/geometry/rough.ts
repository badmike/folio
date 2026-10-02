import rough from 'roughjs'
import type { Options, OpSet } from 'roughjs/bin/core'
import type { ArrowObject, Arrowhead, ShapeObject, ShapeStyle, Vec2 } from '@folio/document'
import { catmullRomSvg, dashPattern, dashPolyline } from './curves'
import { roundedPolygon, roundedShape, shapeVertices } from '../shapes'
import type { VisualTheme } from '../contract'

/** Flattened, renderer-agnostic geometry for shapes and arrows. */
export interface PathGeometry {
  /** Open polylines drawn with `strokeWidth`. */
  strokes: Vec2[][]
  /** Closed polygons filled solid with the fill colour. */
  fills: Vec2[][]
  /** Hachure polylines drawn with `hatchWidth` in the fill colour. */
  hatch: Vec2[][]
  /** Closed polygons always filled with the STROKE colour (filled arrowheads). */
  solids: Vec2[][]
  strokeWidth: number
  hatchWidth: number
}

const generator = rough.generator()

/** Steps used when flattening one cubic bezier. */
const BEZIER_STEPS = 10

/**
 * Convert a roughjs OpSet (move / lineTo / bcurveTo) into polylines. A move to the
 * current point continues the polyline, so path segments join instead of overlapping.
 */
export function opsetToPolylines(set: OpSet, steps = BEZIER_STEPS): Vec2[][] {
  const out: Vec2[][] = []
  let cur: Vec2[] | null = null
  let px = 0
  let py = 0
  for (const op of set.ops) {
    const d = op.data
    if (op.op === 'move') {
      if (cur && Math.abs(d[0] - px) < 1e-6 && Math.abs(d[1] - py) < 1e-6) continue
      if (cur && cur.length > 1) out.push(cur)
      cur = [{ x: d[0], y: d[1] }]
      px = d[0]; py = d[1]
    } else if (op.op === 'lineTo') {
      if (!cur) cur = [{ x: px, y: py }]
      cur.push({ x: d[0], y: d[1] })
      px = d[0]; py = d[1]
    } else if (op.op === 'bcurveTo') {
      if (!cur) cur = [{ x: px, y: py }]
      const x0 = px, y0 = py
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t
        cur.push({
          x: a * x0 + b * d[0] + c * d[2] + e * d[4],
          y: a * y0 + b * d[1] + c * d[3] + e * d[5],
        })
      }
      px = d[4]; py = d[5]
    }
  }
  if (cur && cur.length > 1) out.push(cur)
  return out
}

function stableSeed(seed: number): number {
  const s = Math.floor(Math.abs(seed)) % 2147483647
  return s === 0 ? 1 : s // roughjs treats 0 as "random"
}

export function effectiveRoughness(style: ShapeStyle, theme: VisualTheme): number {
  return theme === 'clean' ? 0 : Math.max(0, style.roughness)
}

function baseOptions(style: ShapeStyle, theme: VisualTheme, seedOffset = 0): Options {
  const roughness = effectiveRoughness(style, theme)
  const hasFill = !!style.fillColor
  return {
    roughness,
    seed: stableSeed(style.seed + seedOffset),
    strokeWidth: style.strokeWidth,
    stroke: style.strokeColor,
    disableMultiStroke: roughness === 0,
    disableMultiStrokeFill: true,
    fill: hasFill ? style.fillColor : undefined,
    fillStyle: style.fillStyle ?? (roughness === 0 ? 'solid' : 'hachure'),
    hachureGap: Math.max(6, style.strokeWidth * 4),
    fillWeight: Math.max(1, style.strokeWidth * 0.5),
    preserveVertices: roughness === 0,
  }
}

function collect(drawable: { sets: OpSet[] }, geo: PathGeometry): void {
  for (const set of drawable.sets) {
    const lines = opsetToPolylines(set)
    if (set.type === 'path') geo.strokes.push(...lines)
    else if (set.type === 'fillPath') geo.fills.push(...lines.filter((l) => l.length >= 3))
    else if (set.type === 'fillSketch') geo.hatch.push(...lines)
  }
}

export function buildShapeGeometry(shape: ShapeObject, theme: VisualTheme): PathGeometry {
  const { width: w, height: h, style } = shape
  const o = baseOptions(style, theme)
  const geo: PathGeometry = {
    strokes: [], fills: [], hatch: [], solids: [],
    strokeWidth: style.strokeWidth,
    hatchWidth: Math.max(1, style.strokeWidth * 0.5),
  }
  const rounded = roundedShape(shape.kind, w, h, style.roundness)
  switch (shape.kind) {
    case 'rectangle':
    case 'triangle':
    case 'diamond':
      // like Excalidraw, a rounded outline keeps its joins so arcs meet the edges
      if (rounded) collect(generator.path(rounded.d, { ...o, preserveVertices: true }), geo)
      else if (shape.kind === 'rectangle') collect(generator.rectangle(0, 0, w, h, o), geo)
      else collect(generator.polygon(shapeVertices(shape.kind, w, h)!.map((p) => [p.x, p.y] as [number, number]), o), geo)
      break
    case 'ellipse': collect(generator.ellipse(w / 2, h / 2, w, h, o), geo); break
    case 'line':
      if (shape.points && shape.points.length >= 2) {
        collect(generator.linearPath(shape.points.map((p) => [p.x, p.y] as [number, number]), { ...o, fill: undefined }), geo)
      } else collect(generator.line(0, 0, w, h, { ...o, fill: undefined }), geo)
      break
    case 'frame': {
      // frames are always clean, thin and unfilled; the name is drawn by the painters
      const d = roundedPolygon(shapeVertices('frame', w, h)!, Math.min(8, Math.min(w, h) / 4)).d
      collect(generator.path(d, { ...o, roughness: 0, disableMultiStroke: true, fill: undefined, strokeWidth: 1, preserveVertices: true }), geo)
      geo.strokeWidth = 1
      return geo
    }
    case 'blur':
      return geo // the effect is painted from the frame buffer
  }
  applyDashes(geo, style)
  return geo
}

/**
 * Hand-drawn look for a smooth flattened curve: resample and displace points
 * perpendicular to the path by low-frequency deterministic noise (ends pinned).
 */
export function wobblePath(path: Vec2[], seed: number, roughness: number): Vec2[] {
  const out: Vec2[] = []
  const total = path.reduce((l, p, i) => (i ? l + Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y) : 0), 0)
  if (total < 1) return path
  const p1 = (Math.abs(seed) % 97) * 0.37
  const p2 = (Math.abs(seed) % 53) * 0.71
  const amp = 1.1 * Math.min(roughness, 2)
  let s = 0
  for (let i = 0; i < path.length; i++) {
    if (i > 0) s += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)]
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const taper = Math.min(1, s / 18, (total - s) / 18)
    const off = amp * taper * (Math.sin(s * 0.05 + p1) * 0.6 + Math.sin(s * 0.13 + p2) * 0.4)
    out.push({ x: path[i].x - ((b.y - a.y) / l) * off, y: path[i].y + ((b.x - a.x) / l) * off })
  }
  return out
}

/** Replace solid outline polylines with dashes for dashed / dotted stroke styles. */
function applyDashes(geo: PathGeometry, style: ShapeStyle): void {
  const pat = dashPattern(style.strokeStyle, style.strokeWidth)
  if (!pat) return
  geo.strokes = geo.strokes.flatMap((line) => dashPolyline(line, pat[0], pat[1]))
}

/** Length of arrow-head barbs in world units. */
export function arrowHeadLength(style: ShapeStyle, shaftLength: number): number {
  return Math.min(shaftLength * 0.6, 12 + style.strokeWidth * 2.5)
}

/** Barb tips of an arrow head at `tip` pointing away from `from`. */
export function arrowHeadPoints(from: Vec2, tip: Vec2, len: number): [Vec2, Vec2] {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x)
  const spread = Math.PI / 7
  return [
    { x: tip.x - len * Math.cos(ang - spread), y: tip.y - len * Math.sin(ang - spread) },
    { x: tip.x - len * Math.cos(ang + spread), y: tip.y - len * Math.sin(ang + spread) },
  ]
}

/**
 * Unit tangent pointing OUT of the path at its end (`atEnd`) or start, measured
 * over a short look-back so curved/elbow paths give a stable direction.
 */
export function pathEndTangent(path: Vec2[], atEnd: boolean, lookBack = 6): Vec2 {
  const n = path.length
  const tip = atEnd ? path[n - 1] : path[0]
  let acc = 0
  for (let k = 1; k < n; k++) {
    const q = atEnd ? path[n - 1 - k] : path[k]
    const d = Math.hypot(tip.x - q.x, tip.y - q.y)
    if (d >= lookBack || k === n - 1) {
      const l = d || 1
      return { x: (tip.x - q.x) / l, y: (tip.y - q.y) / l }
    }
    acc = d
  }
  void acc
  return { x: 1, y: 0 }
}

/** Geometry parts of one arrowhead: open strokes and solid polygons, all in world space. */
export interface HeadParts {
  strokes: Vec2[][]
  solids: Vec2[][]
}

/**
 * Arrowhead of `kind` with its tip at `tip`, `dir` = unit tangent pointing out
 * of the path at that end. Pure clean geometry (the rough theme jitters the
 * outline separately).
 */
export function arrowheadParts(kind: Arrowhead, tip: Vec2, dir: Vec2, style: ShapeStyle, shaftLength: number): HeadParts {
  const out: HeadParts = { strokes: [], solids: [] }
  if (kind === 'none') return out
  const len = arrowHeadLength(style, shaftLength)
  const from = { x: tip.x - dir.x, y: tip.y - dir.y }
  const nx = -dir.y, ny = dir.x
  switch (kind) {
    case 'arrow': {
      const [a, b] = arrowHeadPoints(from, tip, len)
      out.strokes.push([a, tip, b])
      break
    }
    case 'triangle': {
      const [a, b] = arrowHeadPoints(from, tip, len)
      out.solids.push([tip, a, b])
      break
    }
    case 'triangle-outline': {
      const [a, b] = arrowHeadPoints(from, tip, len)
      out.strokes.push([tip, a, b, tip])
      break
    }
    case 'dot': {
      const r = dotRadius(style, len)
      out.solids.push(circlePolygon({ x: tip.x - dir.x * r, y: tip.y - dir.y * r }, r, 16))
      break
    }
    case 'dot-outline': {
      const r = dotRadius(style, len)
      const ring = circlePolygon({ x: tip.x - dir.x * r, y: tip.y - dir.y * r }, r, 24)
      out.strokes.push([...ring, ring[0]])
      break
    }
    case 'diamond':
    case 'diamond-outline': {
      const w = len * DIAMOND_HALF_WIDTH
      const poly = [
        tip,
        { x: tip.x - dir.x * len / 2 + nx * w, y: tip.y - dir.y * len / 2 + ny * w },
        { x: tip.x - dir.x * len, y: tip.y - dir.y * len },
        { x: tip.x - dir.x * len / 2 - nx * w, y: tip.y - dir.y * len / 2 - ny * w },
      ]
      if (kind === 'diamond') out.solids.push(poly)
      else out.strokes.push([...poly, poly[0]])
      break
    }
    case 'bar':
      out.strokes.push(crossBar(tip, nx, ny, barHalf(style, len)))
      break
    case 'crowfoot-one':
      out.strokes.push(crossBar({ x: tip.x - dir.x * len * 0.5, y: tip.y - dir.y * len * 0.5 }, nx, ny, barHalf(style, len)))
      break
    case 'crowfoot-many':
    case 'crowfoot-one-or-many': {
      const half = barHalf(style, len)
      const apex = { x: tip.x - dir.x * len, y: tip.y - dir.y * len }
      out.strokes.push(
        [apex, { x: tip.x + nx * half, y: tip.y + ny * half }],
        [apex, { x: tip.x - nx * half, y: tip.y - ny * half }],
      )
      if (kind === 'crowfoot-one-or-many') {
        out.strokes.push(crossBar({ x: tip.x - dir.x * len * 1.3, y: tip.y - dir.y * len * 1.3 }, nx, ny, half))
      }
      break
    }
  }
  return out
}

/** Half-width of a diamond head relative to its length. */
const DIAMOND_HALF_WIDTH = 0.4

const dotRadius = (style: ShapeStyle, len: number): number => Math.min(len * 0.4, 3 + style.strokeWidth * 1.4)
const barHalf = (style: ShapeStyle, len: number): number => Math.min(len * 0.55, 6 + style.strokeWidth * 1.5)

function crossBar(c: Vec2, nx: number, ny: number, half: number): Vec2[] {
  return [{ x: c.x + nx * half, y: c.y + ny * half }, { x: c.x - nx * half, y: c.y - ny * half }]
}

function circlePolygon(c: Vec2, r: number, steps: number): Vec2[] {
  const poly: Vec2[] = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    poly.push({ x: c.x + Math.cos(t) * r, y: c.y + Math.sin(t) * r })
  }
  return poly
}

/**
 * How far back from the tip the shaft must stop so it does not show through the
 * head: outline heads are hollow, every other head sits on top of the shaft.
 */
export function arrowheadTrim(kind: Arrowhead, style: ShapeStyle, shaftLength: number): number {
  const len = arrowHeadLength(style, shaftLength)
  switch (kind) {
    case 'triangle-outline': return len * Math.cos(Math.PI / 7)
    case 'dot-outline': return dotRadius(style, len) * 2
    case 'diamond-outline': return len
    default: return 0
  }
}

/** Cut `start` / `end` arc length off the ends of a flattened path; null when nothing is left. */
export function trimPath(path: Vec2[], start: number, end: number): Vec2[] | null {
  if (start <= 0 && end <= 0) return path
  let total = 0
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
  const to = total - Math.max(0, end)
  const from = Math.max(0, start)
  if (to - from < 0.5) return null
  const out: Vec2[] = []
  let acc = 0
  for (let i = 0; i < path.length; i++) {
    const seg = i ? Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y) : 0
    const next = acc + seg
    if (i > 0 && seg > 0) {
      const lerp = (d: number): Vec2 => {
        const t = (d - acc) / seg
        return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t }
      }
      if (out.length === 0 && next > from) out.push(lerp(from))
      if (out.length > 0) {
        if (next >= to) { out.push(lerp(to)); break }
        out.push(path[i])
      }
    }
    acc = next
  }
  return out.length > 1 ? out : null
}

/** Arrow shaft + heads in WORLD space (arrows carry an identity transform). `path` = arrowPath(). */
export function buildArrowGeometry(arrow: ArrowObject, path: Vec2[], theme: VisualTheme): PathGeometry {
  const style = arrow.style
  const geo: PathGeometry = {
    strokes: [], fills: [], hatch: [], solids: [],
    strokeWidth: style.strokeWidth,
    hatchWidth: style.strokeWidth,
  }
  let len = 0
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
  if (len < 0.5) return geo
  const dashed = style.strokeStyle === 'dashed' || style.strokeStyle === 'dotted'
  const size = Math.max(...path.map((p) => p.x)) - Math.min(...path.map((p) => p.x))
  const height = Math.max(...path.map((p) => p.y)) - Math.min(...path.map((p) => p.y))
  const maxSize = Math.max(size, height)
  const roughness = effectiveRoughness(style, theme)
  const o: Options = {
    ...baseOptions(style, theme), fill: undefined,
    roughness: maxSize >= 50 ? roughness : Math.min(roughness / (maxSize < 10 ? 3 : 2), 2.5),
    preserveVertices: true,
    disableMultiStroke: roughness === 0 || dashed,
  }
  if (dashed && roughness > 0) geo.strokeWidth += 0.5
  const rough = o.roughness ?? 0
  if (path.length === 2) collect(generator.line(path[0].x, path[0].y, path[1].x, path[1].y, o), geo)
  else if (rough === 0) geo.strokes.push(path)
  else if (arrow.arrowType === 'curved') {
    const points = [path[0], ...(arrow.waypoints ?? []), path[path.length - 1]]
    collect(generator.path(catmullRomSvg(points), o), geo)
  }
  else collect(generator.linearPath(path.map((p) => [p.x, p.y] as [number, number]), o), geo)
  applyDashes(geo, style)
  const head = (kind: Arrowhead, atEnd: boolean, seedOffset: number): void => {
    if (kind === 'none') return
    const tip = atEnd ? path[path.length - 1] : path[0]
    const parts = arrowheadParts(kind, tip, pathEndTangent(path, atEnd), style, len)
    const ho: Options = {
      ...o, seed: stableSeed(style.seed + seedOffset),
      roughness: Math.min(kind === 'dot' ? 0.5 : 1, rough),
      disableMultiStroke: rough === 0,
    }
    for (const line of parts.strokes) {
      // heads stay solid even for dashed shafts
      if (rough === 0) geo.strokes.push(line)
      else collect(generator.linearPath(line.map((p) => [p.x, p.y] as [number, number]), ho), geo)
    }
    for (const poly of parts.solids) {
      if (rough === 0) { geo.solids.push(poly); continue }
      const tmp: PathGeometry = { strokes: [], fills: [], hatch: [], solids: [], strokeWidth: 0, hatchWidth: 0 }
      const fillOptions = { ...ho, fill: style.strokeColor, fillStyle: 'solid' }
      if (kind === 'dot') {
        const r = dotRadius(style, arrowHeadLength(style, len))
        const dir = pathEndTangent(path, atEnd)
        collect(generator.ellipse(tip.x - dir.x * r, tip.y - dir.y * r, r * 2, r * 2, fillOptions), tmp)
      } else collect(generator.polygon(poly.map((p) => [p.x, p.y] as [number, number]), fillOptions), tmp)
      geo.solids.push(...tmp.fills)
      geo.strokes.push(...tmp.strokes)
    }
  }
  head(arrow.endHead, true, 1)
  head(arrow.startHead, false, 2)
  return geo
}
