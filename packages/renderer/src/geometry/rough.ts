import rough from 'roughjs'
import type { Options, OpSet } from 'roughjs/bin/core'
import type { ArrowObject, ShapeObject, ShapeStyle, Vec2 } from '@folio/document'
import type { VisualTheme } from '../contract'

/** Flattened, renderer-agnostic geometry for shapes and arrows. */
export interface PathGeometry {
  /** Open polylines drawn with `strokeWidth`. */
  strokes: Vec2[][]
  /** Closed polygons filled solid with the fill colour. */
  fills: Vec2[][]
  /** Hachure polylines drawn with `hatchWidth` in the fill colour. */
  hatch: Vec2[][]
  strokeWidth: number
  hatchWidth: number
}

const generator = rough.generator()

/** Steps used when flattening one cubic bezier. */
const BEZIER_STEPS = 10

/** Convert a roughjs OpSet (move / lineTo / bcurveTo) into polylines. */
export function opsetToPolylines(set: OpSet, steps = BEZIER_STEPS): Vec2[][] {
  const out: Vec2[][] = []
  let cur: Vec2[] | null = null
  let px = 0
  let py = 0
  for (const op of set.ops) {
    const d = op.data
    if (op.op === 'move') {
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
    fillStyle: roughness === 0 ? 'solid' : 'hachure',
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
    strokes: [], fills: [], hatch: [],
    strokeWidth: style.strokeWidth,
    hatchWidth: Math.max(1, style.strokeWidth * 0.5),
  }
  switch (shape.kind) {
    case 'rectangle': collect(generator.rectangle(0, 0, w, h, o), geo); break
    case 'ellipse': collect(generator.ellipse(w / 2, h / 2, w, h, o), geo); break
    case 'triangle':
      collect(generator.polygon([[w / 2, 0], [w, h], [0, h]], o), geo); break
    case 'diamond':
      collect(generator.polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]], o), geo); break
    case 'line':
      collect(generator.line(0, 0, w, h, { ...o, fill: undefined }), geo); break
  }
  return geo
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

/** Arrow shaft + heads in WORLD space (arrows carry an identity transform). */
export function buildArrowGeometry(arrow: ArrowObject, start: Vec2, end: Vec2, theme: VisualTheme): PathGeometry {
  const style = arrow.style
  const geo: PathGeometry = {
    strokes: [], fills: [], hatch: [],
    strokeWidth: style.strokeWidth,
    hatchWidth: style.strokeWidth,
  }
  const len = Math.hypot(end.x - start.x, end.y - start.y)
  if (len < 0.5) return geo
  const o = { ...baseOptions(style, theme), fill: undefined }
  collect(generator.line(start.x, start.y, end.x, end.y, o), geo)
  const headLen = arrowHeadLength(style, len)
  const head = (from: Vec2, tip: Vec2, seedOffset: number) => {
    const [a, b] = arrowHeadPoints(from, tip, headLen)
    collect(
      generator.linearPath(
        [[a.x, a.y], [tip.x, tip.y], [b.x, b.y]],
        { ...baseOptions(style, theme, seedOffset), fill: undefined },
      ),
      geo,
    )
  }
  if (arrow.endHead === 'arrow') head(start, end, 1)
  if (arrow.startHead === 'arrow') head(end, start, 2)
  return geo
}
