/**
 * Editor-local geometry: world bounds, hit testing, lasso tests and arrow
 * endpoint resolution. Pure functions over the document model.
 */
import { createId } from '@folio/document'
import type { ArrowObject, CanvasObject, ObjectId, Rect, TextObject, Transform, Vec2 } from '@folio/document'
import {
  hitTestObject as rendererHitTest, localBounds as rendererLocalBounds, measureText,
  objectIntersectsLasso as rendererLasso, objectWorldBounds, pointInPolygon as rendererPip,
  resolveArrowEndpoints as rendererResolveArrow,
} from '@folio/renderer'

export type Resolve = (id: ObjectId) => CanvasObject | undefined

export const IDENTITY: Transform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }

export { createId }

// -- transforms --------------------------------------------------------------

export function localToWorld(t: Transform, p: Vec2): Vec2 {
  const sx = p.x * t.scaleX
  const sy = p.y * t.scaleY
  const c = Math.cos(t.rotation)
  const s = Math.sin(t.rotation)
  return { x: t.x + sx * c - sy * s, y: t.y + sx * s + sy * c }
}

export function worldToLocal(t: Transform, p: Vec2): Vec2 {
  const dx = p.x - t.x
  const dy = p.y - t.y
  const c = Math.cos(-t.rotation)
  const s = Math.sin(-t.rotation)
  const rx = dx * c - dy * s
  const ry = dx * s + dy * c
  return { x: t.scaleX === 0 ? 0 : rx / t.scaleX, y: t.scaleY === 0 ? 0 : ry / t.scaleY }
}

export function rotateAround(p: Vec2, c: Vec2, angle: number): Vec2 {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

// -- rect helpers ------------------------------------------------------------

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height

export const rectContainsPoint = (r: Rect, p: Vec2): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height

/** True when `outer` fully contains `inner` (with a small tolerance). */
export const rectContainsRect = (outer: Rect, inner: Rect, eps = 0.5): boolean =>
  inner.x >= outer.x - eps && inner.y >= outer.y - eps &&
  inner.x + inner.width <= outer.x + outer.width + eps && inner.y + inner.height <= outer.y + outer.height + eps

export function unionRects(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export const inflate = (r: Rect, d: number): Rect => ({
  x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d,
})

export function rectFromPoints(a: Vec2, b: Vec2): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

// -- bounds (delegating to the renderer so selection matches what is drawn) -----

export const LINE_HEIGHT = 1.3

/** Size of a text object in local units. */
export function estimateTextSize(o: Pick<TextObject, 'text' | 'fontSize' | 'fontFamily' | 'width' | 'align'>): { width: number; height: number } {
  const m = measureText(o)
  return { width: m.width, height: m.height }
}

/** Object bounds in local space (arrows and groups have none: returns undefined). */
export function localBounds(o: CanvasObject): Rect | undefined {
  return rendererLocalBounds(o) ?? undefined
}

/** Resolve an arrow's endpoints, following bindings to the target's bounds. */
export function resolveArrowEndpoints(a: ArrowObject, resolve: Resolve): { start: Vec2; end: Vec2 } {
  return rendererResolveArrow(a, resolve)
}

/** World-space AABB. Groups return undefined (derive from children). */
export function worldBounds(o: CanvasObject, resolve: Resolve): Rect | undefined {
  if (o.type === 'group') return undefined
  return objectWorldBounds(o, resolve, (a) => rendererResolveArrow(a, resolve))
}

export function hitTestObject(o: CanvasObject, p: Vec2, tol: number, resolve: Resolve): boolean {
  if (o.type === 'group') return false
  return rendererHitTest(o, p, tol, resolve)
}

export const pointInPolygon = rendererPip

export function objectIntersectsLasso(o: CanvasObject, lasso: Vec2[], resolve: Resolve): boolean {
  if (o.type === 'group') return false
  return rendererLasso(o, lasso, resolve)
}

/** Does the eraser segment a→b (radius r) touch the object? */
export function segmentTouchesObject(o: CanvasObject, a: Vec2, b: Vec2, r: number, resolve: Resolve): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const step = Math.max(r * 0.75, 0.25)
  const n = Math.max(1, Math.ceil(len / step))
  const p = { x: 0, y: 0 }
  for (let i = 0; i <= n; i++) {
    p.x = a.x + ((b.x - a.x) * i) / n
    p.y = a.y + ((b.y - a.y) * i) / n
    if (hitTestObject(o, p, r, resolve)) return true
  }
  return false
}
