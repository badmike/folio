import { adaptColor } from '@folio/document'
import type { InkPoint, StrokeStyle } from '@folio/document'
import type { Camera, LiveInkLayer, Size } from './contract'
import { highlighterBlend, highlighterPasses } from './geometry/ink'

/** Width multiplier for a pressure value; matches perfect-freehand thinning 0.5 at mid pressure. */
export function pressureFactor(pressure: number): number {
  const p = Math.max(0, Math.min(1, pressure))
  return 0.5 + p
}

/**
 * Canvas2D immediate-mode layer for the in-progress stroke.
 * Pens are drawn incrementally (only new segments as quadratic curves between
 * sample midpoints). Highlighters (and translucent pens) redraw the whole path
 * each append as a single fill or stroke so overlapping segments never double-blend.
 */
export function createLiveInkLayer(canvas: HTMLCanvasElement): LiveInkLayer {
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d', { desynchronized: true, alpha: true }) as CanvasRenderingContext2D | null
  } catch {
    ctx = null
  }
  let style: StrokeStyle | null = null
  let pts: InkPoint[] = []
  let completed: { style: StrokeStyle; pts: InkPoint[] }[] = []
  let drawn = 0 // number of points already rendered incrementally
  let viewport: Size = { width: canvas.clientWidth || 1, height: canvas.clientHeight || 1, dpr: 1 }
  let camera: Camera = { x: 0, y: 0, zoom: 1 }
  let prevMid: { x: number; y: number } | null = null
  let background = '#ffffff'
  /** Colour actually painted for the current stroke on this page background. */
  const paintColor = () => adaptColor(style!.color, background)

  const sx = (x: number) => (x - camera.x) * camera.zoom
  const sy = (y: number) => (y - camera.y) * camera.zoom

  function setup(): void {
    if (!ctx) return
    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }

  function clearAll(): void {
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setup()
  }

  const wholePath = () => !!style && (style.tool === 'highlighter' || style.opacity < 1)

  function drawWhole(clear = true): void {
    if (!ctx || !style || !pts.length) return
    if (clear) { clearAll(); drawCompleted() }
    ctx.globalAlpha = style.opacity
    ctx.strokeStyle = paintColor()
    ctx.fillStyle = paintColor()
    ctx.lineWidth = Math.max(0.5, style.width * camera.zoom)
    ctx.lineCap = style.tool === 'highlighter' ? 'butt' : 'round'
    if (style.tool === 'highlighter') {
      // each pass is its own fill, so ink laid over itself builds up like the committed stroke
      for (const pass of highlighterPasses(pts, style.width, style.cap ?? 'flat')) {
        ctx.beginPath()
        for (const polygon of pass) {
          ctx.moveTo(sx(polygon[0].x), sy(polygon[0].y))
          for (let i = 1; i < polygon.length; i++) ctx.lineTo(sx(polygon[i].x), sy(polygon[i].y))
          ctx.closePath()
        }
        ctx.fill()
      }
    } else if (pts.length === 1) {
      ctx.beginPath()
      ctx.arc(sx(pts[0].x), sy(pts[0].y), ctx.lineWidth / 2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.beginPath()
      ctx.moveTo(sx(pts[0].x), sy(pts[0].y))
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (sx(pts[i].x) + sx(pts[i + 1].x)) / 2
        const my = (sy(pts[i].y) + sy(pts[i + 1].y)) / 2
        ctx.quadraticCurveTo(sx(pts[i].x), sy(pts[i].y), mx, my)
      }
      const last = pts[pts.length - 1]
      ctx.lineTo(sx(last.x), sy(last.y))
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  function widthAt(p: InkPoint): number {
    const base = style!.width * camera.zoom
    return Math.max(0.5, style!.pressureSensitive ? base * pressureFactor(p.pressure) : base)
  }

  function drawIncremental(): void {
    if (!ctx || !style) return
    ctx.globalAlpha = style.opacity
    ctx.strokeStyle = paintColor()
    ctx.fillStyle = paintColor()
    ctx.lineCap = 'round'
    for (; drawn < pts.length; drawn++) {
      const p = pts[drawn]
      if (drawn === 0) {
        ctx.beginPath()
        ctx.arc(sx(p.x), sy(p.y), widthAt(p) / 2, 0, Math.PI * 2)
        ctx.fill()
        prevMid = { x: sx(p.x), y: sy(p.y) }
        continue
      }
      const q = pts[drawn - 1]
      const mid = { x: (sx(q.x) + sx(p.x)) / 2, y: (sy(q.y) + sy(p.y)) / 2 }
      ctx.lineWidth = (widthAt(q) + widthAt(p)) / 2
      ctx.beginPath()
      ctx.moveTo(prevMid!.x, prevMid!.y)
      ctx.quadraticCurveTo(sx(q.x), sy(q.y), mid.x, mid.y)
      ctx.stroke()
      prevMid = mid
    }
    ctx.globalAlpha = 1
  }

  function drawCompleted(): void {
    const active = { style, pts, drawn, prevMid }
    for (const stroke of completed) {
      style = stroke.style
      pts = stroke.pts
      drawn = 0
      prevMid = null
      if (wholePath()) drawWhole(false)
      else drawIncremental()
    }
    style = active.style
    pts = active.pts
    drawn = active.drawn
    prevMid = active.prevMid
  }

  const layer: LiveInkLayer = {
    setBackground(color) {
      background = color
    },
    begin(s) {
      style = s
      // the live canvas sits over the scene, so a marker mixes with it through CSS like the committed ink
      canvas.style.mixBlendMode = s.tool === 'highlighter' ? highlighterBlend(background) : ''
      pts = []
      drawn = 0
      prevMid = null
    },
    finish() {
      if (style && pts.length) completed.push({ style, pts })
      style = null
      pts = []
      drawn = 0
      prevMid = null
    },
    clearCommitted() {
      completed = []
      layer.redraw(camera)
    },
    cancel() {
      style = null
      pts = []
      drawn = 0
      prevMid = null
      clearAll()
      drawCompleted()
    },
    append(points, cam) {
      if (!style || !points.length) return
      const camChanged = cam.x !== camera.x || cam.y !== camera.y || cam.zoom !== camera.zoom
      camera = { x: cam.x, y: cam.y, zoom: cam.zoom }
      for (const p of points) pts.push(p)
      if (camChanged && drawn > 0) {
        layer.redraw(camera)
        return
      }
      if (wholePath()) drawWhole()
      else drawIncremental()
    },
    redraw(cam) {
      camera = { x: cam.x, y: cam.y, zoom: cam.zoom }
      if (!style) { clearAll(); drawCompleted(); return }
      if (wholePath()) {
        drawWhole()
        return
      }
      clearAll()
      drawCompleted()
      drawn = 0
      prevMid = null
      drawIncremental()
    },
    clear() {
      completed = []
      pts = []
      drawn = 0
      prevMid = null
      style = null
      clearAll()
    },
    resize(vp) {
      viewport = vp
      canvas.width = Math.max(1, Math.round(vp.width * vp.dpr))
      canvas.height = Math.max(1, Math.round(vp.height * vp.dpr))
      if (canvas.style) {
        canvas.style.width = `${vp.width}px`
        canvas.style.height = `${vp.height}px`
      }
      setup()
      layer.redraw(camera)
    },
    dispose() {
      completed = []
      pts = []
      style = null
      ctx = null
    },
  }
  return layer
}
