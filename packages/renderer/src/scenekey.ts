import type { ArrowObject, CanvasObject, Vec2 } from '@folio/document'
import type { VisualTheme } from './contract'

/** Cheap cache version key for an object's tessellated geometry. */
export function objectKey(obj: CanvasObject, theme: VisualTheme): string {
  let k = `${obj.updatedAt}|${theme}`
  if (obj.type === 'shape') k += `|${obj.width}x${obj.height}|${obj.kind}|${obj.style.seed}|${obj.style.roughness}`
  else if (obj.type === 'ink') k += `|${obj.points.length}`
  return k
}

export function arrowKey(a: ArrowObject, start: Vec2, end: Vec2, theme: VisualTheme): string {
  return `${a.updatedAt}|${theme}|${start.x.toFixed(2)},${start.y.toFixed(2)},${end.x.toFixed(2)},${end.y.toFixed(2)}`
}

export function isRenderable(obj: CanvasObject, hidden?: Set<string>): boolean {
  return !obj.supersededBy && obj.type !== 'group' && !(hidden && hidden.has(obj.id))
}
