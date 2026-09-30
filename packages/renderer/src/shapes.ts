import type { Roundness, ShapeKind, Vec2 } from '@folio/document'

/** Corner radius for 'round' shapes: a quarter of the shorter side, at most 32 world units (Excalidraw). */
export function cornerRadius(w: number, h: number, roundness: Roundness | undefined): number {
  if (roundness !== 'round') return 0
  return Math.min(32, Math.min(w, h) * 0.25)
}

/** Corner vertices of a polygonal shape in its local box (undefined for ellipses and lines). */
export function shapeVertices(kind: ShapeKind, w: number, h: number): Vec2[] | undefined {
  switch (kind) {
    case 'rectangle':
    case 'frame':
    case 'blur':
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
    case 'triangle':
      return [{ x: w / 2, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
    case 'diamond':
      return [{ x: w / 2, y: 0 }, { x: w, y: h / 2 }, { x: w / 2, y: h }, { x: 0, y: h / 2 }]
    default:
      return undefined
  }
}

/**
 * Round the corners of a closed polygon: each corner is cut `r` (capped at half the
 * adjacent edges) along both edges and joined by a quadratic curve through the vertex.
 * Returns the SVG path (for roughjs) and a flattened polygon (for hit tests / edges).
 */
export function roundedPolygon(pts: Vec2[], r: number, steps = 4): { d: string; polygon: Vec2[] } {
  const n = pts.length
  const polygon: Vec2[] = []
  let d = ''
  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n], cur = pts[i], next = pts[(i + 1) % n]
    const lenIn = Math.hypot(cur.x - prev.x, cur.y - prev.y) || 1
    const lenOut = Math.hypot(next.x - cur.x, next.y - cur.y) || 1
    const ri = Math.min(r, lenIn / 2, lenOut / 2)
    const a = { x: cur.x + ((prev.x - cur.x) / lenIn) * ri, y: cur.y + ((prev.y - cur.y) / lenIn) * ri }
    const b = { x: cur.x + ((next.x - cur.x) / lenOut) * ri, y: cur.y + ((next.y - cur.y) / lenOut) * ri }
    d += (i === 0 ? 'M' : 'L') + `${a.x} ${a.y} Q${cur.x} ${cur.y} ${b.x} ${b.y}`
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, u = 1 - t
      polygon.push({ x: u * u * a.x + 2 * u * t * cur.x + t * t * b.x, y: u * u * a.y + 2 * u * t * cur.y + t * t * b.y })
    }
  }
  return { d: d + 'Z', polygon }
}

/**
 * Closed outline polygon of a shape in its local box (0,0)-(w,h). 'line' returns its
 * polyline (the two end points, or `points` when the line was subdivided).
 */
export function shapeOutline(kind: ShapeKind, w: number, h: number, o: { points?: Vec2[]; roundness?: Roundness; ellipseSteps?: number } = {}): Vec2[] {
  if (kind === 'line') return o.points && o.points.length >= 2 ? o.points : [{ x: 0, y: 0 }, { x: w, y: h }]
  if (kind === 'ellipse') {
    const steps = o.ellipseSteps ?? 64
    const pts: Vec2[] = []
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      pts.push({ x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a) })
    }
    return pts
  }
  const verts = shapeVertices(kind, w, h)!
  const r = kind === 'rectangle' || kind === 'triangle' || kind === 'diamond' ? cornerRadius(w, h, o.roundness) : 0
  return r > 0 ? roundedPolygon(verts, r).polygon : verts
}
