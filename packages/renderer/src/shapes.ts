import type { ShapeKind, Vec2 } from '@folio/document'

/** Closed outline polygon of a shape in its local box (0,0)-(w,h). 'line' returns the two endpoints. */
export function shapeOutline(kind: ShapeKind, w: number, h: number, ellipseSteps = 64): Vec2[] {
  switch (kind) {
    case 'rectangle':
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
    case 'triangle':
      return [{ x: w / 2, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
    case 'diamond':
      return [{ x: w / 2, y: 0 }, { x: w, y: h / 2 }, { x: w / 2, y: h }, { x: 0, y: h / 2 }]
    case 'ellipse': {
      const pts: Vec2[] = []
      for (let i = 0; i < ellipseSteps; i++) {
        const a = (i / ellipseSteps) * Math.PI * 2
        pts.push({ x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a) })
      }
      return pts
    }
    case 'line':
      return [{ x: 0, y: 0 }, { x: w, y: h }]
  }
}
