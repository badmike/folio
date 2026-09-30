import type { ArrowObject, CanvasObject, Vec2 } from '@folio/document'
import type { VisualTheme } from './contract'

/** Cheap cache version key for an object's tessellated geometry (`bg` = page colour, colours are adapted to it). */
export function objectKey(obj: CanvasObject, theme: VisualTheme, bg = ''): string {
  let k = `${obj.updatedAt}|${theme}|${bg}`
  if (obj.type === 'shape') k += `|${obj.width}x${obj.height}|${obj.kind}|${obj.style.seed}|${obj.style.roughness}`
  else if (obj.type === 'ink') k += `|${obj.points.length}`
  return k
}

/** Key of an arrow's geometry: object version + a checksum of its resolved path (bindings can move it). */
export function arrowKey(a: ArrowObject, path: Vec2[], theme: VisualTheme, bg = ''): string {
  let h = 0
  for (const p of path) h = (h * 31 + Math.round(p.x * 100) * 7 + Math.round(p.y * 100)) | 0
  return `${a.updatedAt}|${theme}|${bg}|${path.length}|${h}`
}

export function isRenderable(obj: CanvasObject, hidden?: Set<string>): boolean {
  return !obj.supersededBy && obj.type !== 'group' && !(hidden && hidden.has(obj.id))
}
