import type { Renderer } from './contract'
import { Canvas2DRenderer } from './canvas2d'
import { WebGLRenderer } from './webgl'

export interface CreateRendererOptions {
  prefer?: 'webgl' | 'canvas2d'
}

/**
 * Create the best available renderer for the canvas: WebGL (default) with a
 * Canvas2D fallback when WebGL is unavailable or fails to initialise.
 * Note: a canvas can only hand out one context type, so the fallback uses a
 * fresh canvas only if the caller provides one; otherwise it errors clearly.
 */
export function createRenderer(canvas: HTMLCanvasElement, opts: CreateRendererOptions = {}): Renderer {
  if (opts.prefer !== 'canvas2d' && WebGLRenderer.isSupported()) {
    try {
      return new WebGLRenderer(canvas)
    } catch (err) {
      // getContext('webgl') may have already bound the canvas to a GL context; then 2D is unavailable.
      if (typeof console !== 'undefined') console.warn('[folio/renderer] WebGL unavailable, using Canvas2D', err)
    }
  }
  return new Canvas2DRenderer(canvas)
}
