import type { Rect, Vec2 } from '@folio/document'
import type { Camera } from '@folio/renderer'

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 20

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/** screen = (world - cam) * zoom */
export function worldToScreen(cam: Camera, p: Vec2): Vec2 {
  return { x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom }
}

export function screenToWorld(cam: Camera, p: Vec2): Vec2 {
  return { x: p.x / cam.zoom + cam.x, y: p.y / cam.zoom + cam.y }
}

/** Camera after zooming by `factor` keeping the world point under `screen` fixed. */
export function zoomCameraAt(cam: Camera, screen: Vec2, factor: number): Camera {
  const zoom = clampZoom(cam.zoom * factor)
  const wx = screen.x / cam.zoom + cam.x
  const wy = screen.y / cam.zoom + cam.y
  return { x: wx - screen.x / zoom, y: wy - screen.y / zoom, zoom }
}

/** Camera that fits `rect` (world) into a viewport with `padding` (screen px). */
export function cameraForRect(rect: Rect, vw: number, vh: number, padding = 32, maxZoom = MAX_ZOOM): Camera {
  const availW = Math.max(1, vw - padding * 2)
  const availH = Math.max(1, vh - padding * 2)
  const zoom = Math.min(maxZoom, clampZoom(Math.min(availW / Math.max(rect.width, 1e-6), availH / Math.max(rect.height, 1e-6))))
  return {
    zoom,
    x: rect.x + rect.width / 2 - vw / zoom / 2,
    y: rect.y + rect.height / 2 - vh / zoom / 2,
  }
}

/**
 * Loosely clamp a camera to fixed-page bounds: at least a fraction of the
 * page (or viewport, whichever is smaller) must stay visible on each axis.
 */
export function clampCameraToPage(cam: Camera, page: { width: number; height: number }, vw: number, vh: number): Camera {
  if (vw <= 0 || vh <= 0) return cam
  const visW = vw / cam.zoom
  const visH = vh / cam.zoom
  const keepW = Math.min(visW, page.width) * 0.3
  const keepH = Math.min(visH, page.height) * 0.3
  return {
    zoom: cam.zoom,
    x: Math.min(page.width - keepW, Math.max(keepW - visW, cam.x)),
    y: Math.min(page.height - keepH, Math.max(keepH - visH, cam.y)),
  }
}
