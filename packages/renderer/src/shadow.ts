import type { ShapeObject, TextObject, Transform, Vec2 } from '@folio/document'
import { noteBox, noteOutline, noteTail } from './callouts'
import type { VisualTheme } from './contract'
import type { PathGeometry } from './geometry/rough'
import { invert, pointInPolygon, transformMatrix } from './math'
import { shapeOutline } from './shapes'

/** Shape kinds that cast the theme's offset shadow (closed, convex outlines). */
const SHADOW_KINDS: ReadonlySet<ShapeObject['kind']> = new Set(['rectangle', 'ellipse', 'triangle', 'diamond'])

export function castsShadow(obj: ShapeObject | TextObject, theme: VisualTheme): boolean {
  if (!theme.shadow) return false
  return obj.type === 'shape' ? SHADOW_KINDS.has(obj.kind) : !!obj.background
}

/**
 * The shadow's offset in the object's local space: it falls down and right on the page
 * (whatever the rotation or scale), further for bolder strokes.
 */
export function shadowOffset(t: Transform, strokeWidth: number): Vec2 {
  const d = 3 + strokeWidth * 1.2
  const inv = invert(transformMatrix({ ...t, x: 0, y: 0 }))
  return inv ? { x: inv[0] * d + inv[2] * d, y: inv[1] * d + inv[3] * d } : { x: d, y: d }
}

const shift = (pts: Vec2[], o: Vec2): Vec2[] => pts.map((p) => ({ x: p.x + o.x, y: p.y + o.y }))

/**
 * Shadow of a shape in its local space, already offset. A flat-filled shape casts its silhouette;
 * an unfilled or hatched one only the part of its offset copy that lies outside it, so nothing
 * shows through its inside.
 */
export function shapeShadow(shape: ShapeObject, geo: PathGeometry, offset: Vec2): PathGeometry {
  const filled = geo.fills.length > 0 && (geo.fillOpacity ?? 1) === 1
  const outline = shapeOutline(shape.kind, shape.width, shape.height, { roundness: shape.style.roundness, ellipseSteps: 32 })
  const base = { hatch: [], solids: [], strokeWidth: geo.strokeWidth, hatchWidth: 0 }
  // marker hands (strokes drawn as solids) cast a plain silhouette, without their overshooting ends
  const marker = geo.solids.length > 0 && geo.strokes.length === 0
  const strokes = marker ? [] : geo.strokes.map((l) => shift(l, offset))
  if (filled) return { ...base, strokes, fills: (geo.fills.length ? geo.fills : [outline]).map((p) => shift(p, offset)) }
  return {
    ...base,
    fills: convexDifference(shift(outline, offset), outline),
    strokes: strokes.flatMap((l) => runsOutside(l, outline)),
  }
}

/** Shadow of a note: its box and pointer, in the note's local space, already offset. */
export function noteShadow(note: TextObject, tail: Vec2 | undefined, offset: Vec2): PathGeometry {
  const box = noteBox(note)
  const fills = [noteOutline(box), noteTail(box, tail)].filter((p): p is Vec2[] => !!p).map((p) => shift(p, offset))
  return { strokes: [], fills, hatch: [], solids: [], strokeWidth: 0, hatchWidth: 0 }
}

/** Parts of a polyline outside `poly`. */
function runsOutside(line: Vec2[], poly: Vec2[]): Vec2[][] {
  const out: Vec2[][] = []
  let run: Vec2[] = []
  for (const p of line) {
    if (pointInPolygon(p, poly)) {
      if (run.length > 1) out.push(run)
      run = []
    } else run.push(p)
  }
  if (run.length > 1) out.push(run)
  return out
}

function signedArea(p: Vec2[]): number {
  let a = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y)
  return a
}

/** Sutherland–Hodgman: the part of `poly` on one side of the line a→b (`side` = +1 or -1). */
function clipHalf(poly: Vec2[], a: Vec2, b: Vec2, side: number): Vec2[] {
  const s = (p: Vec2) => side * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))
  const out: Vec2[] = []
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    const sp = s(p), sq = s(q)
    if (sp >= 0) out.push(p)
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq)
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
    }
  }
  return out
}

/** `a` minus `b` for convex polygons, as convex pieces (one per edge of `b` that `a` reaches past). */
export function convexDifference(a: Vec2[], b: Vec2[]): Vec2[][] {
  const inside = signedArea(b) > 0 ? -1 : 1
  const pieces: Vec2[][] = []
  let rest = a
  for (let i = 0; i < b.length && rest.length >= 3; i++) {
    const p = b[i], q = b[(i + 1) % b.length]
    const outside = clipHalf(rest, p, q, -inside)
    if (outside.length >= 3 && Math.abs(signedArea(outside)) > 1e-3) pieces.push(outside)
    rest = clipHalf(rest, p, q, inside)
  }
  return pieces
}
