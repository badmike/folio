import { INK_POINT_STRIDE } from '@folio/document'
import type { InkStroke, StrokeStyle } from '@folio/document'

/**
 * Build a committed InkStroke from raw world-space samples
 * ([x,y,pressure,tiltX,tiltY,t] * n). Points are re-based to the stroke's
 * bbox min, which becomes the transform origin.
 */
export function buildInkStroke(
  world: number[],
  o: { id: string; style: StrokeStyle; pointerType: InkStroke['pointerType']; startedAt: number; z: number; now?: number },
): InkStroke {
  let minX = Infinity
  let minY = Infinity
  for (let i = 0; i + 1 < world.length; i += INK_POINT_STRIDE) {
    if (world[i] < minX) minX = world[i]
    if (world[i + 1] < minY) minY = world[i + 1]
  }
  if (minX === Infinity) { minX = 0; minY = 0 }
  const pts = new Array<number>(world.length)
  for (let i = 0; i < world.length; i += INK_POINT_STRIDE) {
    pts[i] = world[i] - minX
    pts[i + 1] = world[i + 1] - minY
    pts[i + 2] = world[i + 2]
    pts[i + 3] = world[i + 3]
    pts[i + 4] = world[i + 4]
    pts[i + 5] = world[i + 5]
  }
  const now = o.now ?? Date.now()
  return {
    id: o.id,
    type: 'ink',
    transform: { x: minX, y: minY, rotation: 0, scaleX: 1, scaleY: 1 },
    z: o.z,
    createdAt: now,
    updatedAt: now,
    points: pts,
    style: { ...o.style },
    startedAt: o.startedAt,
    pointerType: o.pointerType,
  }
}
