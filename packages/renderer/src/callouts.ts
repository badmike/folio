/** Geometry of notes (text with a box and an optional pointer) and counters (numbered pins). */
import { COUNTER_TIP, notePadding, type Rect, type ShapeObject, type TextObject, type Vec2 } from '@folio/document'
import { roundedPolygon } from './shapes'
import { layoutText, measureText, type TextLayout } from './text'

/** Box of a note in local space: the text box grown by the padding. */
export function noteBox(t: TextObject): Rect {
  const m = measureText(t)
  const pad = notePadding(t.fontSize)
  return { x: -pad, y: -pad, width: m.width + pad * 2, height: m.height + pad * 2 }
}

/** Corner radius of a note's box. */
const noteRadius = (box: Rect): number => Math.min(6, box.width / 4, box.height / 4)

/** Rounded outline of a note's box. */
export function noteOutline(box: Rect): Vec2[] {
  const { x, y, width: w, height: h } = box
  const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
  return roundedPolygon(corners, noteRadius(box), 2 / 3, 3).polygon
}

/**
 * The pointer of a note as a triangle [base, tip, base], undefined when the note has none or the
 * point lies inside the box. A pointer that reaches only a little past the box is a small
 * equilateral nub on the edge facing it; a longer one is a wedge from the box centre to the
 * point. Filled in the box colour, so only the part outside the box shows.
 */
export function noteTail(box: Rect, tail: Vec2 | undefined): Vec2[] | undefined {
  if (!tail) return undefined
  if (tail.x >= box.x && tail.x <= box.x + box.width && tail.y >= box.y && tail.y <= box.y + box.height) return undefined
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const len = Math.hypot(tail.x - c.x, tail.y - c.y)
  const dx = (tail.x - c.x) / len, dy = (tail.y - c.y) / len
  // where the line from the centre leaves the box
  const exit = Math.min(dx ? box.width / 2 / Math.abs(dx) : Infinity, dy ? box.height / 2 / Math.abs(dy) : Infinity)
  const side = Math.min(box.width, box.height) * 0.5
  const height = (side * Math.sqrt(3)) / 2
  if (len - exit <= height * MINIMAL_TAIL) {
    // the nub stands square on the side it leaves through, kept clear of the rounded corners
    const vertical = Math.abs(dx) * (box.height / 2) >= Math.abs(dy) * (box.width / 2)
    const n = vertical ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) }
    const along = vertical ? c.y + dy * exit : c.x + dx * exit
    const margin = noteRadius(box) + side / 2
    const lo = (vertical ? box.y : box.x) + margin, hi = (vertical ? box.y + box.height : box.x + box.width) - margin
    const at = lo <= hi ? Math.max(lo, Math.min(hi, along)) : (lo + hi) / 2
    const edge = vertical ? box.x + (n.x > 0 ? box.width : 0) : box.y + (n.y > 0 ? box.height : 0)
    const e = vertical ? { x: edge - n.x * 0.5, y: at } : { x: at, y: edge - n.y * 0.5 }
    const tx = -n.y * (side / 2), ty = n.x * (side / 2)
    return [{ x: e.x + tx, y: e.y + ty }, { x: e.x + n.x * height, y: e.y + n.y * height }, { x: e.x - tx, y: e.y - ty }]
  }
  const half = Math.min(box.width, box.height) * 0.22
  const nx = -dy * half, ny = dx * half
  return [{ x: c.x + nx, y: c.y + ny }, tail, { x: c.x - nx, y: c.y - ny }]
}

/** A pointer reaching less than this many nub heights past the box is drawn as the nub. */
const MINIMAL_TAIL = 1.5

/** Where the tail of a counter points when it has none stored: the bottom-right corner. */
export function counterTail(s: ShapeObject): Vec2 {
  return s.tail ?? { x: s.width, y: s.height }
}

/** Direction (radians, in the counter's unit circle) its tip points in. */
function counterAngle(s: ShapeObject): number {
  const rx = s.width / 2, ry = s.height / 2
  const t = counterTail(s)
  const ux = rx > 0 ? (t.x - rx) / rx : 0, uy = ry > 0 ? (t.y - ry) / ry : 0
  return ux || uy ? Math.atan2(uy, ux) : Math.PI / 4
}

/** Local point of a counter's tip, undefined for a plain circle. */
export function counterTip(s: ShapeObject): Vec2 | undefined {
  const style = s.counterStyle ?? 'pin'
  if (style === 'circle') return undefined
  const a = counterAngle(s), k = COUNTER_TIP[style]
  return { x: s.width / 2 + Math.cos(a) * k * (s.width / 2), y: s.height / 2 + Math.sin(a) * k * (s.height / 2) }
}

/**
 * Outline of a counter in its box, worked out on the unit circle and stretched to the box:
 * 'pin' has a sharp corner where a square's corner would be (its sides meet the circle 45
 * degrees either side of the tip), 'drop' a raindrop whose sides leave the circle smoothly and taper to a long tip, 'circle' none.
 */
export function counterOutline(s: ShapeObject, steps = 40): Vec2[] {
  const rx = s.width / 2, ry = s.height / 2
  const at = (ux: number, uy: number): Vec2 => ({ x: rx + ux * rx, y: ry + uy * ry })
  const style = s.counterStyle ?? 'pin'
  if (style === 'circle') return Array.from({ length: steps }, (_, i) => at(Math.cos((i / steps) * Math.PI * 2), Math.sin((i / steps) * Math.PI * 2)))
  const theta = counterAngle(s)
  const k = COUNTER_TIP[style]
  const cos = Math.cos(theta), sin = Math.sin(theta)
  // points below are on the unit circle with the tip along +x; turn them towards the tail
  const turn = (p: Vec2): Vec2 => at(p.x * cos - p.y * sin, p.x * sin + p.y * cos)
  // half the angle of the circle the tip replaces
  const gap = style === 'pin' ? Math.PI / 4 : (Math.PI * 55) / 180
  const out: Vec2[] = []
  for (let i = 0; i <= steps; i++) {
    const a = gap + (i / steps) * (Math.PI * 2 - gap * 2)
    out.push(turn({ x: Math.cos(a), y: Math.sin(a) }))
  }
  if (style === 'pin') {
    out.push(turn({ x: k, y: 0 }))
    return out
  }
  // drop: sides leave the circle along its tangent and meet in a small rounded tip
  const cubic = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): void => {
    for (let i = 1; i <= 12; i++) {
      const t = i / 12, u = 1 - t
      out.push(turn({
        x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
        y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
      }))
    }
  }
  const g = Math.sin(gap), h = Math.cos(gap)
  const pull = 0.5
  const low = { x: k - 0.05, y: -0.035 }, high = { x: k - 0.05, y: 0.035 }
  cubic({ x: h, y: -g }, { x: h + g * pull, y: -g + h * pull }, { x: k - 0.75, y: -0.12 }, low)
  // the rounded tip passes through (k, 0)
  for (let i = 1; i <= 6; i++) {
    const t = i / 6, u = 1 - t
    const cx = 2 * k - low.x
    out.push(turn({ x: u * u * low.x + 2 * u * t * cx + t * t * high.x, y: u * u * low.y + t * t * high.y }))
  }
  cubic(high, { x: k - 0.75, y: 0.12 }, { x: h + g * pull, y: g - h * pull }, { x: h, y: g })
  return out
}

/** The number of a counter, laid out centred in its circle (shrunk to fit long labels). */
export function counterLabel(s: ShapeObject): { layout: TextLayout; fontSize: number; x: number; y: number } | undefined {
  if (!s.label) return undefined
  const d = Math.min(s.width, s.height)
  let fontSize = d * 0.5
  const fontFamily = s.fontFamily ?? 'sans'
  let layout = layoutText({ text: s.label, fontSize, fontFamily, align: 'center' })
  if (layout.width > d * 0.8) {
    fontSize *= (d * 0.8) / layout.width
    layout = layoutText({ text: s.label, fontSize, fontFamily, align: 'center' })
  }
  return { layout, fontSize, x: (s.width - layout.width) / 2, y: (s.height - layout.height) / 2 }
}
