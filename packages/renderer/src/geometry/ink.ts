import earcut from 'earcut'
import { getStroke } from 'perfect-freehand'
import type { InkStroke, Vec2 } from '@folio/document'
import { STRIDE } from '../bounds'

/** Options passed to perfect-freehand for a stroke; exported for tests. */
export function freehandOptions(stroke: Pick<InkStroke, 'style' | 'pointerType'>) {
  const { style } = stroke
  if (style.tool === 'highlighter') {
    return {
      size: style.width,
      thinning: 0,
      smoothing: 0.5,
      streamline: 0.4,
      simulatePressure: false,
      start: { cap: false },
      end: { cap: false },
      last: true,
    }
  }
  const realPressure = style.pressureSensitive && stroke.pointerType !== 'mouse'
  return {
    size: style.width,
    thinning: realPressure ? 0.5 : 0.3,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: !realPressure,
    last: true,
  }
}

/** Closed outline polygon of a stroke in LOCAL coordinates. */
export function strokeOutline(stroke: InkStroke): Vec2[] {
  const pts: number[][] = []
  const p = stroke.points
  for (let i = 0; i + 1 < p.length; i += STRIDE) {
    pts.push([p[i], p[i + 1], p[i + 2] ?? 0.5])
  }
  if (!pts.length) return []
  const outline = getStroke(pts, freehandOptions(stroke))
  return outline.map(([x, y]) => ({ x, y }))
}

/** Triangulate a simple polygon; returns triangle vertex indices into `polygon`. */
export function triangulate(polygon: Vec2[]): number[] {
  if (polygon.length < 3) return []
  const flat = new Array<number>(polygon.length * 2)
  for (let i = 0; i < polygon.length; i++) {
    flat[i * 2] = polygon[i].x
    flat[i * 2 + 1] = polygon[i].y
  }
  return earcut(flat)
}
