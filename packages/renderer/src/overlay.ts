import type { ObjectId, Rect, Vec2 } from '@folio/document'
import type { Camera, Scene } from './contract'
import { worldCorners } from './bounds'

export const ACCENT = '#3b82f6'
/** Handle square size in screen pixels. */
export const HANDLE_SIZE = 10
/** Distance of the rotation handle above the top edge, in screen pixels. */
export const ROTATE_HANDLE_OFFSET = 28

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate'

export interface OverlayPoly {
  /** Screen-space (CSS px) points. */
  points: Vec2[]
  closed: boolean
  fill?: string
  stroke?: string
  strokeWidth?: number
}

export function worldToScreen(camera: Camera, p: Vec2): Vec2 {
  return { x: (p.x - camera.x) * camera.zoom, y: (p.y - camera.y) * camera.zoom }
}

/** Screen-space positions of the selection handles (also used by the editor for hit-testing). */
export function selectionHandles(bounds: Rect, rotation: number, camera: Camera): { id: HandleId; screen: Vec2 }[] {
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  const c = Math.cos(rotation), s = Math.sin(rotation)
  const at = (fx: number, fy: number): Vec2 => {
    const lx = (fx - 0.5) * bounds.width
    const ly = (fy - 0.5) * bounds.height
    return worldToScreen(camera, { x: cx + lx * c - ly * s, y: cy + lx * s + ly * c })
  }
  const top = at(0.5, 0)
  // "up" direction in screen space (rotated), for the rotation handle
  const up = { x: s, y: -c }
  return [
    { id: 'nw', screen: at(0, 0) },
    { id: 'n', screen: top },
    { id: 'ne', screen: at(1, 0) },
    { id: 'e', screen: at(1, 0.5) },
    { id: 'se', screen: at(1, 1) },
    { id: 's', screen: at(0.5, 1) },
    { id: 'sw', screen: at(0, 1) },
    { id: 'w', screen: at(0, 0.5) },
    { id: 'rotate', screen: { x: top.x + up.x * ROTATE_HANDLE_OFFSET, y: top.y + up.y * ROTATE_HANDLE_OFFSET } },
  ]
}

function circle(c: Vec2, r: number, steps = 16): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < steps; i++) out.push({ x: c.x + r * Math.cos((i / steps) * Math.PI * 2), y: c.y + r * Math.sin((i / steps) * Math.PI * 2) })
  return out
}

function rectPoly(camera: Camera, r: Rect): Vec2[] {
  return [
    worldToScreen(camera, { x: r.x, y: r.y }),
    worldToScreen(camera, { x: r.x + r.width, y: r.y }),
    worldToScreen(camera, { x: r.x + r.width, y: r.y + r.height }),
    worldToScreen(camera, { x: r.x, y: r.y + r.height }),
  ]
}

/** All selection/interaction overlay primitives in screen space. Order = paint order. */
export function buildOverlay(scene: Scene, camera: Camera): OverlayPoly[] {
  const out: OverlayPoly[] = []
  if (scene.highlights) {
    for (const r of scene.highlights) out.push({ points: rectPoly(camera, r), closed: true, fill: 'rgba(255,205,0,0.38)' })
  }
  const sel = scene.selection
  if (!sel) return out
  if (sel.bindingTargetId) {
    const t = scene.resolve(sel.bindingTargetId)
    const corners = t && worldCorners(t)
    if (corners) {
      out.push({
        points: corners.map((p) => worldToScreen(camera, p)),
        closed: true, fill: 'rgba(20,184,166,0.12)', stroke: '#14b8a6', strokeWidth: 3,
      })
    }
  }
  if (sel.marquee) {
    out.push({ points: rectPoly(camera, sel.marquee), closed: true, fill: 'rgba(59,130,246,0.10)', stroke: ACCENT, strokeWidth: 1 })
  }
  if (sel.lasso && sel.lasso.length > 1) {
    out.push({ points: sel.lasso.map((p) => worldToScreen(camera, p)), closed: false, stroke: ACCENT, strokeWidth: 1.5 })
  }
  if (sel.bounds && sel.ids.length) {
    const rot = sel.rotation ?? 0
    const hs = selectionHandles(sel.bounds, rot, camera)
    const pos = (id: HandleId) => hs.find((h) => h.id === id)!.screen
    out.push({ points: [pos('nw'), pos('ne'), pos('se'), pos('sw')], closed: true, stroke: ACCENT, strokeWidth: 1.5 })
    if (sel.showHandles) {
      out.push({ points: [pos('n'), pos('rotate')], closed: false, stroke: ACCENT, strokeWidth: 1 })
      const h = HANDLE_SIZE / 2
      for (const handle of hs) {
        if (handle.id === 'rotate') {
          out.push({ points: circle(handle.screen, h + 1), closed: true, fill: '#ffffff', stroke: ACCENT, strokeWidth: 1.5 })
          continue
        }
        const p = handle.screen
        const c = Math.cos(rot), s = Math.sin(rot)
        const corner = (dx: number, dy: number): Vec2 => ({ x: p.x + dx * c - dy * s, y: p.y + dx * s + dy * c })
        out.push({
          points: [corner(-h, -h), corner(h, -h), corner(h, h), corner(-h, h)],
          closed: true, fill: '#ffffff', stroke: ACCENT, strokeWidth: 1.5,
        })
      }
    }
  }
  return out
}

export type { ObjectId }
