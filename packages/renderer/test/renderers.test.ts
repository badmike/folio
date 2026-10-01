import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Canvas2DRenderer, renderPageToImage, renderToCanvas } from '../src/canvas2d'
import { createLiveInkLayer } from '../src/live-ink'
import { WebGLRenderer, scaleBucket } from '../src/webgl'
import { createRenderer } from '../src/factory'
import { arrow, image, ink, scene, shape, text, useFakeMeasure, PAGE } from './helpers'
import type { CanvasObject } from '@folio/document'

beforeAll(useFakeMeasure)

/** A 2D context that records calls and never throws. */
function mockCtx() {
  const calls: string[] = []
  const target: Record<string, unknown> = {}
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop === 'calls') return calls
      if (prop in t) return t[prop]
      return (...args: unknown[]) => {
        calls.push(prop)
        void args
        return prop === 'measureText' ? { width: 10 } : undefined
      }
    },
    set(t, prop: string, v) {
      t[prop] = v
      return true
    },
  })
  return ctx as unknown as CanvasRenderingContext2D & { calls: string[] }
}

function mockCanvas(ctx: unknown, extra: Record<string, unknown> = {}) {
  return {
    width: 300, height: 200, clientWidth: 300, clientHeight: 200, style: {},
    getContext: () => ctx,
    addEventListener() {}, removeEventListener() {},
    ...extra,
  } as unknown as HTMLCanvasElement
}

const objects = (): CanvasObject[] => [
  ink('i', [[0, 0, 0.3], [30, 10, 0.6], [60, 0, 0.9]]),
  shape('s', 'rectangle', 100, 60, { label: 'hi' }, { fillColor: '#ffcc00' }),
  shape('e', 'ellipse', 100, 60),
  arrow('a', { x: 0, y: 0 }, { x: 100, y: 100 }, { label: 'go', startBinding: { objectId: 's' } }),
  text('t', 'hello\nworld', { width: 80 }),
  image('m', 40, 40),
]

describe('Canvas2DRenderer', () => {
  it('renders all object types + overlay against a mocked context', () => {
    const ctx = mockCtx()
    const r = new Canvas2DRenderer(mockCanvas(ctx))
    r.resize({ width: 300, height: 200, dpr: 2 })
    const sc = scene(objects(), {
      selection: { ids: ['s'], bounds: { x: 0, y: 0, width: 100, height: 60 }, showHandles: true, marquee: { x: 0, y: 0, width: 10, height: 10 } },
      previews: [shape('p', 'diamond', 30, 30)],
      hiddenIds: new Set(['e']),
      highlights: [{ x: 0, y: 0, width: 10, height: 10 }],
    })
    expect(() => r.render(sc, { x: 10, y: 10, zoom: 1.5 })).not.toThrow()
    expect(ctx.calls).toContain('fillText')
    expect(ctx.calls).toContain('stroke')
    expect(ctx.calls).toContain('fill')
    r.invalidate(['s'])
    r.invalidate()
    expect(() => r.render(sc, { x: 0, y: 0, zoom: 0.5 })).not.toThrow()
    r.dispose()
    expect(() => r.render(sc, { x: 0, y: 0, zoom: 1 })).not.toThrow()
  })

  it('skips superseded objects and hidden ids', () => {
    const ctx = mockCtx()
    const r = new Canvas2DRenderer(mockCanvas(ctx))
    const s = ink('i', [[0, 0], [10, 10]], { supersededBy: 'x' })
    r.render(scene([s], { page: { ...PAGE, background: { ...PAGE.background, pattern: 'blank' } } }), { x: 0, y: 0, zoom: 1 })
    expect(ctx.calls).not.toContain('closePath')
  })

  it('draws fixed pages with desk and every pattern', () => {
    for (const pattern of ['blank', 'ruled', 'grid', 'dot'] as const) {
      const ctx = mockCtx()
      const r = new Canvas2DRenderer(mockCanvas(ctx))
      const page = { ...PAGE, kind: 'fixed' as const, width: 500, height: 600, background: { ...PAGE.background, pattern } }
      expect(() => r.render(scene([], { page }), { x: -20, y: -20, zoom: 1 })).not.toThrow()
    }
  })

  it('renderToCanvas works on arbitrary canvases', () => {
    const ctx = mockCtx()
    expect(() => renderToCanvas(scene(objects()), { x: 0, y: 0, zoom: 2 }, mockCanvas(ctx))).not.toThrow()
    expect(() => renderToCanvas(scene([]), { x: 0, y: 0, zoom: 1 }, mockCanvas(null))).toThrow()
  })

  it('renderPageToImage returns a blob (OffscreenCanvas path)', async () => {
    const ctx = mockCtx()
    const blob = new Blob(['png'])
    const created: { w: number; h: number }[] = []
    class FakeOffscreen {
      constructor(public width: number, public height: number) { created.push({ w: width, h: height }) }
      getContext() { return ctx }
      convertToBlob() { return Promise.resolve(blob) }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
    try {
      const out = await renderPageToImage(scene(objects()), { bounds: { x: 0, y: 0, width: 100, height: 50 }, scale: 2, background: true })
      expect(out).toBe(blob)
      expect(created[0]).toEqual({ w: 200, h: 100 })
      await renderPageToImage(scene([]), { bounds: { x: 0, y: 0, width: 10000, height: 100 }, scale: 4, background: false, maxDimension: 1000 })
      expect(created[1].w).toBeLessThanOrEqual(1000)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('loads images through the resolver and requests a redraw', async () => {
    const ctx = mockCtx()
    const r = new Canvas2DRenderer(mockCanvas(ctx))
    const bitmap = {} as ImageBitmap
    r.setImageSource(async () => bitmap)
    const dirty = vi.fn()
    r.onDirty = dirty
    const sc = scene([image('m', 10, 10)])
    r.render(sc, { x: 0, y: 0, zoom: 1 })
    await new Promise((res) => setTimeout(res, 0))
    expect(dirty).toHaveBeenCalled()
    r.render(sc, { x: 0, y: 0, zoom: 1 })
    expect(ctx.calls).toContain('drawImage')
  })
})

describe('LiveInkLayer', () => {
  const pt = (x: number, y: number, pressure = 0.5) => ({ x, y, pressure, tiltX: 0, tiltY: 0, t: 0 })
  const pen = { tool: 'pen' as const, color: '#000', width: 4, opacity: 1, pressureSensitive: true }

  it('requests a desynchronized context and handles dpr', () => {
    const ctx = mockCtx()
    const getContext = vi.fn(() => ctx)
    const canvas = mockCanvas(ctx, { getContext })
    const layer = createLiveInkLayer(canvas)
    expect(getContext).toHaveBeenCalledWith('2d', expect.objectContaining({ desynchronized: true }))
    layer.resize({ width: 100, height: 80, dpr: 2 })
    expect(canvas.width).toBe(200)
    expect(canvas.height).toBe(160)
  })

  it('draws only new segments on each append (pen)', () => {
    const ctx = mockCtx()
    const layer = createLiveInkLayer(mockCanvas(ctx))
    layer.resize({ width: 100, height: 100, dpr: 1 })
    const cam = { x: 0, y: 0, zoom: 1 }
    layer.begin(pen)
    layer.append([pt(0, 0), pt(10, 0), pt(20, 5)], cam)
    const strokes1 = ctx.calls.filter((c) => c === 'stroke').length
    const clears1 = ctx.calls.filter((c) => c === 'clearRect').length
    layer.append([pt(30, 10)], cam)
    expect(ctx.calls.filter((c) => c === 'stroke').length).toBe(strokes1 + 1)
    expect(ctx.calls.filter((c) => c === 'clearRect').length).toBe(clears1)
  })

  it('keeps completed ink across strokes and preserves active ink when the scene catches up', () => {
    const ctx = mockCtx()
    const layer = createLiveInkLayer(mockCanvas(ctx))
    const cam = { x: 0, y: 0, zoom: 1 }
    layer.begin(pen)
    layer.append([pt(0, 0), pt(10, 0)], cam)
    layer.finish()
    const clears = ctx.calls.filter((c) => c === 'clearRect').length
    layer.begin(pen)
    layer.append([pt(20, 0), pt(30, 0)], cam)
    expect(ctx.calls.filter((c) => c === 'clearRect').length).toBe(clears)
    ctx.calls.length = 0
    layer.clearCommitted()
    expect(ctx.calls.filter((c) => c === 'stroke')).toHaveLength(1)
    layer.append([pt(40, 0)], cam)
    expect(ctx.calls.filter((c) => c === 'stroke')).toHaveLength(2)
    layer.cancel()
    ctx.calls.length = 0
    layer.redraw(cam)
    expect(ctx.calls).not.toContain('stroke')
  })

  it('redraws the whole path for highlighters (no overlapping alpha)',  () => {
    const ctx = mockCtx()
    const layer = createLiveInkLayer(mockCanvas(ctx))
    layer.resize({ width: 100, height: 100, dpr: 1 })
    layer.begin({ tool: 'highlighter', color: '#ff0', width: 12, opacity: 0.4, pressureSensitive: false })
    const cam = { x: 0, y: 0, zoom: 1 }
    layer.append([pt(0, 0), pt(10, 0), pt(20, 5)], cam)
    const before = ctx.calls.filter((c) => c === 'clearRect').length
    const fills = ctx.calls.filter((c) => c === 'fill').length
    layer.append([pt(30, 10)], cam)
    expect(ctx.calls.filter((c) => c === 'clearRect').length).toBe(before + 1)
    expect(ctx.calls.filter((c) => c === 'fill').length).toBe(fills + 1)
    expect(ctx.calls).not.toContain('stroke')
    expect((ctx as unknown as { globalAlpha: number }).globalAlpha).toBe(1)
  })

  it.each(['flat', 'round', 'slanted', 'curvy'] as const)('live highlighter uses the %s cap geometry', async (cap) => {
    const { highlighterParts } = await import('../src/geometry/ink')
    const ctx = mockCtx()
    const move = vi.fn()
    ctx.moveTo = move
    const layer = createLiveInkLayer(mockCanvas(ctx))
    layer.begin({ tool: 'highlighter', color: '#ff0', width: 20, opacity: 0.4, pressureSensitive: false, cap })
    const points = [pt(0, 0), pt(100, 0)]
    layer.append(points, { x: -10, y: -20, zoom: 2 })
    expect(move.mock.calls).toEqual(highlighterParts(points, 20, cap).map((p) => [(p[0].x + 10) * 2, (p[0].y + 20) * 2]))
  })

  it('redraw / clear / dispose do not throw, even without a context', () => {
    const layer = createLiveInkLayer(mockCanvas(mockCtx()))
    layer.begin(pen)
    layer.append([pt(0, 0)], { x: 0, y: 0, zoom: 1 })
    layer.redraw({ x: 5, y: 5, zoom: 2 })
    layer.clear()
    layer.dispose()
    const bare = createLiveInkLayer(mockCanvas(null))
    bare.begin(pen)
    expect(() => bare.append([pt(0, 0), pt(1, 1)], { x: 0, y: 0, zoom: 1 })).not.toThrow()
  })
})

/** Permissive WebGL stand-in: enough to exercise renderer control flow. */
function mockGL() {
  const calls: string[] = []
  const gl: Record<string, unknown> = {}
  return new Proxy(gl, {
    get(t, prop: string) {
      if (prop === 'calls') return calls
      if (prop in t) return t[prop]
      if (/^[A-Z0-9_]+$/.test(prop)) return 1
      return (...args: unknown[]) => {
        calls.push(prop)
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return true
        if (prop === 'isContextLost') return false
        if (prop.startsWith('create')) return { id: calls.length }
        if (prop === 'getUniformLocation') return { name: args[1] }
        return undefined
      }
    },
  }) as unknown as WebGL2RenderingContext & { calls: string[] }
}

describe('WebGLRenderer (mock GL)', () => {
  beforeAll(() => {
    // text rasterisation surface
    vi.stubGlobal('OffscreenCanvas', class {
      width = 1
      height = 1
      getContext() { return mockCtx() }
    })
  })

  it('renders a scene, caches meshes and re-uses them', () => {
    const gl = mockGL()
    const listeners: Record<string, EventListener> = {}
    const canvas = mockCanvas(null, {
      getContext: (t: string) => (t === 'webgl2' ? gl : null),
      addEventListener: (n: string, f: EventListener) => { listeners[n] = f },
    })
    const r = new WebGLRenderer(canvas)
    r.resize({ width: 300, height: 200, dpr: 2 })
    const sc = scene(objects(), {
      selection: { ids: ['s'], bounds: { x: 0, y: 0, width: 100, height: 60 }, showHandles: true },
      previews: [shape('p', 'triangle', 30, 30)],
    })
    r.render(sc, { x: 0, y: 0, zoom: 1 })
    const uploads = gl.calls.filter((c) => c === 'bufferData').length
    r.render(sc, { x: -50, y: -20, zoom: 2 }) // pan/zoom: no re-tessellation of cached meshes
    const uploads2 = gl.calls.filter((c) => c === 'bufferData').length
    // second frame only re-streams previews/overlay/arrow-free meshes: no per-object rebuild
    expect(uploads2 - uploads).toBeLessThanOrEqual(3)
    r.invalidate(['i'])
    r.render(sc, { x: 0, y: 0, zoom: 1 })
    expect(gl.calls.filter((c) => c === 'bufferData').length).toBeGreaterThan(uploads2)
    r.dispose()
  })

  it('survives context loss and restoration', () => {
    const gl = mockGL()
    const l: Record<string, EventListener> = {}
    const canvas = mockCanvas(null, {
      getContext: () => gl,
      addEventListener: (n: string, f: EventListener) => { l[n] = f },
    })
    const r = new WebGLRenderer(canvas)
    const dirty = vi.fn()
    r.onDirty = dirty
    const sc = scene(objects())
    const prevent = vi.fn()
    l.webglcontextlost({ preventDefault: prevent } as unknown as Event)
    expect(prevent).toHaveBeenCalled()
    const n = gl.calls.length
    r.render(sc, { x: 0, y: 0, zoom: 1 })
    expect(gl.calls.length).toBe(n) // no GL work while lost
    l.webglcontextrestored({} as Event)
    expect(dirty).toHaveBeenCalled()
    expect(() => r.render(sc, { x: 0, y: 0, zoom: 1 })).not.toThrow()
  })

  it('throws on shader compile failure with the log', () => {
    const gl = mockGL()
    ;(gl as unknown as Record<string, unknown>).getShaderParameter = () => false
    ;(gl as unknown as Record<string, unknown>).getShaderInfoLog = () => 'boom'
    expect(() => new WebGLRenderer(mockCanvas(null, { getContext: () => gl }))).toThrow(/boom/)
  })

  it('zoom buckets round up in half octaves', () => {
    expect(scaleBucket(1)).toBe(1)
    expect(scaleBucket(1.1)).toBeCloseTo(Math.SQRT2)
    expect(scaleBucket(0.01)).toBe(0.25)
    expect(scaleBucket(3)).toBeGreaterThanOrEqual(3)
  })

  it('factory falls back to Canvas2D', () => {
    const r = createRenderer(mockCanvas(mockCtx()), { prefer: 'canvas2d' })
    expect(r).toBeInstanceOf(Canvas2DRenderer)
    // happy-dom has no WebGL → fallback path
    const r2 = createRenderer(mockCanvas(mockCtx()))
    expect(r2).toBeInstanceOf(Canvas2DRenderer)
  })
})
