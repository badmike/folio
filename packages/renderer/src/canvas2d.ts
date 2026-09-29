import type { ArrowObject, CanvasObject, InkStroke, Page, Rect, ShapeObject, Vec2 } from '@folio/document'
import { resolveArrowEndpoints } from './arrows'
import { DESK_COLOR, pageRect, patternFade } from './background'
import { parseColor } from './color'
import type { Camera, Renderer, Scene, Size, VisualTheme } from './contract'
import { buildArrowGeometry, buildShapeGeometry, type PathGeometry } from './geometry/rough'
import { strokeOutline } from './geometry/ink'
import { ImageCache, type ImageResolver } from './images'
import { transformMatrix } from './math'
import { buildOverlay } from './overlay'
import { arrowKey, isRenderable, objectKey } from './scenekey'
import { labelLayout, layoutText } from './text'
import { drawTextLayout, type Ctx2D } from './textdraw'

export type Canvas2DTarget = HTMLCanvasElement | OffscreenCanvas

function rgba(css: string | undefined, opacity = 1): string {
  const [r, g, b, a] = parseColor(css)
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${+(a * opacity).toFixed(4)})`
}

interface CacheEntry<T> {
  key: string
  value: T
}

/** Cached CPU geometry used by the Canvas2D painter. */
export class GeometryStore {
  private ink = new Map<string, CacheEntry<Vec2[]>>()
  private paths = new Map<string, CacheEntry<PathGeometry>>()

  outline(s: InkStroke, theme: VisualTheme): Vec2[] {
    const key = objectKey(s, theme)
    const hit = this.ink.get(s.id)
    if (hit && hit.key === key) return hit.value
    const value = strokeOutline(s)
    this.ink.set(s.id, { key, value })
    return value
  }

  shape(s: ShapeObject, theme: VisualTheme): PathGeometry {
    const key = objectKey(s, theme)
    const hit = this.paths.get(s.id)
    if (hit && hit.key === key) return hit.value
    const value = buildShapeGeometry(s, theme)
    this.paths.set(s.id, { key, value })
    return value
  }

  arrow(a: ArrowObject, start: Vec2, end: Vec2, theme: VisualTheme): PathGeometry {
    const key = arrowKey(a, start, end, theme)
    const hit = this.paths.get(a.id)
    if (hit && hit.key === key) return hit.value
    const value = buildArrowGeometry(a, start, end, theme)
    this.paths.set(a.id, { key, value })
    return value
  }

  invalidate(ids?: Iterable<string>): void {
    if (!ids) {
      this.ink.clear()
      this.paths.clear()
      return
    }
    for (const id of ids) {
      this.ink.delete(id)
      this.paths.delete(id)
    }
  }
}

function strokePolyline(ctx: Ctx2D, pts: Vec2[]): void {
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.stroke()
}

function drawGeometry(ctx: Ctx2D, geo: PathGeometry, stroke: string, fill: string | null): void {
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (fill) {
    ctx.fillStyle = fill
    for (const poly of geo.fills) {
      ctx.beginPath()
      ctx.moveTo(poly[0].x, poly[0].y)
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y)
      ctx.closePath()
      ctx.fill()
    }
    if (geo.hatch.length) {
      ctx.strokeStyle = fill
      ctx.lineWidth = geo.hatchWidth
      for (const line of geo.hatch) strokePolyline(ctx, line)
    }
  }
  ctx.strokeStyle = stroke
  ctx.lineWidth = geo.strokeWidth
  for (const line of geo.strokes) strokePolyline(ctx, line)
}

export interface PaintOptions {
  /** Draw desk surround for fixed pages (screen view) vs. page fill only (export). */
  desk: boolean
  /** Draw page background at all. */
  background: boolean
  overlay: boolean
}

/** Draw the page background (fill + pattern) in screen space. */
export function drawBackground(ctx: Ctx2D, page: Page, camera: Camera, width: number, height: number, desk: boolean): void {
  const bg = page.background
  const pr = pageRect(page)
  const z = camera.zoom
  // visible page region in screen space
  let x0 = 0, y0 = 0, x1 = width, y1 = height
  if (pr && desk) {
    ctx.fillStyle = DESK_COLOR
    ctx.fillRect(0, 0, width, height)
    x0 = (pr.x - camera.x) * z
    y0 = (pr.y - camera.y) * z
    x1 = x0 + pr.width * z
    y1 = y0 + pr.height * z
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.28)'
    ctx.shadowBlur = 14
    ctx.shadowOffsetY = 3
    ctx.fillStyle = rgba(bg.color)
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    ctx.restore()
  } else {
    ctx.fillStyle = rgba(bg.color)
    ctx.fillRect(0, 0, width, height)
  }
  if (bg.pattern === 'blank' || bg.spacing <= 0) return
  const fade = patternFade(bg.spacing, z)
  if (fade <= 0) return
  const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(width, x1), cy1 = Math.min(height, y1)
  if (cx1 <= cx0 || cy1 <= cy0) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0)
  ctx.clip()
  ctx.globalAlpha = Math.max(0, Math.min(1, bg.opacity)) * fade
  ctx.strokeStyle = rgba(bg.lineColor)
  ctx.fillStyle = rgba(bg.lineColor)
  ctx.lineWidth = 1
  const s = bg.spacing
  const wx0 = camera.x + cx0 / z, wx1 = camera.x + cx1 / z
  const wy0 = camera.y + cy0 / z, wy1 = camera.y + cy1 / z
  const kx0 = Math.ceil(wx0 / s), kx1 = Math.floor(wx1 / s)
  const ky0 = Math.ceil(wy0 / s), ky1 = Math.floor(wy1 / s)
  // guard against absurd line counts
  if ((kx1 - kx0 + 1) * (ky1 - ky0 + 1) > 400000 && bg.pattern === 'dot') {
    ctx.restore()
    return
  }
  if (bg.pattern === 'ruled' || bg.pattern === 'grid') {
    ctx.beginPath()
    for (let k = ky0; k <= ky1; k++) {
      const y = Math.round((k * s - camera.y) * z) + 0.5
      ctx.moveTo(cx0, y)
      ctx.lineTo(cx1, y)
    }
    if (bg.pattern === 'grid') {
      for (let k = kx0; k <= kx1; k++) {
        const x = Math.round((k * s - camera.x) * z) + 0.5
        ctx.moveTo(x, cy0)
        ctx.lineTo(x, cy1)
      }
    }
    ctx.stroke()
  } else {
    const r = Math.max(1.25, z)
    ctx.beginPath()
    for (let i = kx0; i <= kx1; i++) {
      for (let j = ky0; j <= ky1; j++) {
        const x = (i * s - camera.x) * z
        const y = (j * s - camera.y) * z
        ctx.moveTo(x + r, y)
        ctx.arc(x, y, r, 0, Math.PI * 2)
      }
    }
    ctx.fill()
  }
  ctx.restore()
}

function drawImageObject(ctx: Ctx2D, obj: CanvasObject & { type: 'image' }, images: ImageCache): void {
  const img = images.get(obj.assetId)
  if (img) {
    ctx.drawImage(img as CanvasImageSource, 0, 0, obj.width, obj.height)
  } else {
    ctx.fillStyle = 'rgba(128,128,128,0.15)'
    ctx.fillRect(0, 0, obj.width, obj.height)
  }
}

/** Paint a scene into a 2D context whose logical size is width×height CSS px. */
export function paintScene(
  ctx: Ctx2D,
  scene: Scene,
  camera: Camera,
  width: number,
  height: number,
  geo: GeometryStore,
  images: ImageCache,
  opts: PaintOptions,
): void {
  if (opts.background) drawBackground(ctx, scene.page, camera, width, height, opts.desk)
  const z = camera.zoom
  const clean = scene.theme === 'clean'
  const paint = (obj: CanvasObject) => {
    ctx.save()
    if (obj.type === 'arrow') {
      ctx.transform(z, 0, 0, z, -camera.x * z, -camera.y * z)
      const { start, end } = resolveArrowEndpoints(obj, scene.resolve)
      const g = geo.arrow(obj, start, end, scene.theme)
      drawGeometry(ctx, g, rgba(obj.style.strokeColor, obj.style.opacity), null)
      if (obj.label) {
        const l = labelLayout(obj.label, 160, clean)
        const mx = (start.x + end.x) / 2 - l.width / 2
        const my = (start.y + end.y) / 2 - l.height / 2
        ctx.fillStyle = rgba(scene.page.background.color, 0.85)
        ctx.fillRect(mx - 3, my - 1, l.width + 6, l.height + 2)
        drawTextLayout(ctx, l, obj.style.strokeColor, 'center', mx, my)
      }
      ctx.restore()
      return
    }
    const m = transformMatrix(obj.transform)
    // camera · object transform
    ctx.transform(z, 0, 0, z, -camera.x * z, -camera.y * z)
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
    switch (obj.type) {
      case 'ink': {
        const o = geo.outline(obj, scene.theme)
        if (o.length > 2) {
          ctx.fillStyle = rgba(obj.style.color, obj.style.opacity)
          ctx.beginPath()
          ctx.moveTo(o[0].x, o[0].y)
          for (let i = 1; i < o.length; i++) ctx.lineTo(o[i].x, o[i].y)
          ctx.closePath()
          ctx.fill()
        }
        break
      }
      case 'shape': {
        const s = obj.style
        drawGeometry(ctx, geo.shape(obj, scene.theme), rgba(s.strokeColor, s.opacity), s.fillColor ? rgba(s.fillColor, s.opacity) : null)
        if (obj.label) {
          const l = labelLayout(obj.label, obj.width, clean)
          drawTextLayout(ctx, l, s.strokeColor, 'center', (obj.width - l.width) / 2, (obj.height - l.height) / 2)
        }
        break
      }
      case 'text':
        drawTextLayout(ctx, layoutText(obj), obj.color, obj.align)
        break
      case 'image':
        drawImageObject(ctx, obj, images)
        break
      default:
    }
    ctx.restore()
  }
  for (const obj of scene.objects) if (isRenderable(obj, scene.hiddenIds)) paint(obj)
  if (scene.previews) for (const obj of scene.previews) paint(obj)
  if (opts.overlay) drawOverlay(ctx, scene, camera)
}

function drawOverlay(ctx: Ctx2D, scene: Scene, camera: Camera): void {
  for (const poly of buildOverlay(scene, camera)) {
    if (poly.points.length < 2) continue
    ctx.beginPath()
    ctx.moveTo(poly.points[0].x, poly.points[0].y)
    for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y)
    if (poly.closed) ctx.closePath()
    if (poly.fill) {
      ctx.fillStyle = poly.fill
      ctx.fill()
    }
    if (poly.stroke) {
      ctx.strokeStyle = poly.stroke
      ctx.lineWidth = poly.strokeWidth ?? 1
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
  }
}

function get2d(canvas: Canvas2DTarget): Ctx2D | null {
  return canvas.getContext('2d') as Ctx2D | null
}

export class Canvas2DRenderer implements Renderer {
  private ctx: Ctx2D | null
  private viewport: Size = { width: 1, height: 1, dpr: 1 }
  readonly geometry = new GeometryStore()
  readonly images = new ImageCache()
  /** Set by the host: called when async resources (images) became available. */
  onDirty: (() => void) | null = null

  constructor(private canvas: Canvas2DTarget) {
    this.ctx = get2d(canvas)
    this.images.onReady = () => this.onDirty?.()
    const w = (canvas as HTMLCanvasElement).clientWidth
    if (w) this.viewport = { width: w, height: (canvas as HTMLCanvasElement).clientHeight, dpr: 1 }
  }

  setImageSource(resolver: ImageResolver | null): void {
    this.images.setResolver(resolver)
  }

  resize(viewport: Size): void {
    this.viewport = viewport
    this.canvas.width = Math.max(1, Math.round(viewport.width * viewport.dpr))
    this.canvas.height = Math.max(1, Math.round(viewport.height * viewport.dpr))
    const st = (this.canvas as HTMLCanvasElement).style
    if (st) {
      st.width = `${viewport.width}px`
      st.height = `${viewport.height}px`
    }
  }

  render(scene: Scene, camera: Camera): void {
    const ctx = this.ctx
    if (!ctx) return
    const { width, height, dpr } = this.viewport
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    paintScene(ctx, scene, camera, width, height, this.geometry, this.images, { desk: true, background: true, overlay: true })
  }

  /** Render a scene into an arbitrary canvas (1 canvas px = 1 logical px; put scale into camera.zoom). */
  renderToCanvas(scene: Scene, camera: Camera, canvas: Canvas2DTarget, opts: Partial<PaintOptions> = {}): void {
    renderToCanvas(scene, camera, canvas, opts, this.geometry, this.images)
  }

  invalidate(ids?: Iterable<string>): void {
    this.geometry.invalidate(ids)
  }

  dispose(): void {
    this.geometry.invalidate()
    this.images.clear()
    this.ctx = null
  }
}

export function renderToCanvas(
  scene: Scene,
  camera: Camera,
  canvas: Canvas2DTarget,
  opts: Partial<PaintOptions> = {},
  geo: GeometryStore = new GeometryStore(),
  images: ImageCache = new ImageCache(),
): void {
  const ctx = get2d(canvas)
  if (!ctx) throw new Error('2D canvas context unavailable')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  paintScene(ctx, scene, camera, canvas.width, canvas.height, geo, images, {
    desk: false, background: true, overlay: false, ...opts,
  })
}

export interface PageImageOptions {
  /** World-space rectangle to export. */
  bounds: Rect
  /** Pixels per world unit. */
  scale: number
  /** Include the page background (fill + pattern); transparent otherwise. */
  background: boolean
  images?: ImageCache
  /** Max output dimension in pixels (default 8192). */
  maxDimension?: number
}

function createCanvas(w: number, h: number): Canvas2DTarget {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** Render a region of the scene to a PNG blob (export & thumbnails). */
export async function renderPageToImage(scene: Scene, opts: PageImageOptions): Promise<Blob> {
  const max = opts.maxDimension ?? 8192
  let scale = opts.scale
  const longest = Math.max(opts.bounds.width, opts.bounds.height) * scale
  if (longest > max) scale *= max / longest
  const w = Math.max(1, Math.ceil(opts.bounds.width * scale))
  const h = Math.max(1, Math.ceil(opts.bounds.height * scale))
  const canvas = createCanvas(w, h)
  renderToCanvas(
    scene,
    { x: opts.bounds.x, y: opts.bounds.y, zoom: scale },
    canvas,
    { background: opts.background, desk: false, overlay: false },
    new GeometryStore(),
    opts.images ?? new ImageCache(),
  )
  if ('convertToBlob' in canvas) return (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' })
  return new Promise<Blob>((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png')
  })
}
