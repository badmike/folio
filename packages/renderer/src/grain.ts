/**
 * Grain textures: a deterministic speckle that breaks strokes, fills and text into dry chalk
 * or waxy crayon. The same function drives the Canvas2D pattern tile and the WebGL mesh shader
 * (GRAIN_GLSL), so both renderers and exports show the same texture. Grain lives in object
 * space: it moves, scales and rotates with the object instead of swimming across it.
 */
import type { ThemeTexture } from '@folio/document'
import { parseColor } from './color'
import type { Ctx2D } from './textdraw'

export type Grain = Exclude<ThemeTexture, 'none'>

/**
 * Shape of a grain: cell size in object units (x, y), share of cells that keep their colour,
 * size of the coarse blotches in cells, and opacity of the cells that drop out.
 */
export interface GrainStyle {
  cell: readonly [number, number]
  keep: number
  coarse: number
  low: number
  /** Grain strength on text: letters need more of their shape to stay legible. */
  text: number
}

export const GRAINS: Record<Grain, GrainStyle> = {
  // fine dry speckle
  chalk: { cell: [0.6, 0.6], keep: 0.3, coarse: 6, low: 0.15, text: 1 },
  // wax on paper tooth: cells stretched into short streaks, gaps where the paper shows
  crayon: { cell: [1.6, 0.5], keep: 0.36, coarse: 4, low: 0.04, text: 0.4 },
}

/** The texture repeats every GRAIN_TILE cells. */
export const GRAIN_TILE = 128

const hash = (x: number, y: number): number => {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return v - Math.floor(v)
}

/** Opacity factor (0..1) of the grain cell (cx, cy), both in 0..GRAIN_TILE-1. */
export function grainAt(cx: number, cy: number, g: GrainStyle = GRAINS.chalk): number {
  const fine = hash(cx, cy)
  const coarse = hash(Math.floor(cx / g.coarse) + 17, Math.floor(cy / g.coarse) + 17)
  return fine > g.keep ? 0.55 + 0.45 * coarse : g.low * coarse
}

/** GLSL twin of grainAt; `p` = object-space position, the style comes from uniforms. */
export const GRAIN_GLSL = `
uniform vec2 u_grainCell;
uniform vec3 u_grainShape; // keep, coarse, low
float grainHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float grain(vec2 p) {
  vec2 c = mod(floor(p / u_grainCell), ${GRAIN_TILE.toFixed(1)});
  float fine = grainHash(c);
  float coarse = grainHash(floor(c / u_grainShape.y) + 17.0);
  return fine > u_grainShape.x ? 0.55 + 0.45 * coarse : u_grainShape.z * coarse;
}`

const alphaTiles = new Map<Grain, Uint8ClampedArray>()

function tileAlpha(grain: Grain): Uint8ClampedArray {
  let a = alphaTiles.get(grain)
  if (a) return a
  a = new Uint8ClampedArray(GRAIN_TILE * GRAIN_TILE)
  for (let y = 0; y < GRAIN_TILE; y++) for (let x = 0; x < GRAIN_TILE; x++) a[y * GRAIN_TILE + x] = Math.round(grainAt(x, y, GRAINS[grain]) * 255)
  alphaTiles.set(grain, a)
  return a
}

const tiles = new Map<string, HTMLCanvasElement | OffscreenCanvas>()

function grainTile(css: string, strength: number, grain: Grain): HTMLCanvasElement | OffscreenCanvas | null {
  const key = `${grain}|${css}|${strength}`
  const hit = tiles.get(key)
  if (hit) return hit
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(GRAIN_TILE, GRAIN_TILE) : typeof document !== 'undefined' ? document.createElement('canvas') : null
  if (!c) return null
  c.width = GRAIN_TILE
  c.height = GRAIN_TILE
  const ctx = c.getContext('2d') as Ctx2D | null
  if (!ctx || typeof ImageData === 'undefined') return null
  const a = tileAlpha(grain)
  const [r, g, b, alpha] = parseColor(css)
  const img = new ImageData(GRAIN_TILE, GRAIN_TILE)
  for (let i = 0; i < a.length; i++) {
    img.data[i * 4] = r * 255
    img.data[i * 4 + 1] = g * 255
    img.data[i * 4 + 2] = b * 255
    img.data[i * 4 + 3] = (255 + (a[i] - 255) * strength) * alpha
  }
  ctx.putImageData(img, 0, 0)
  if (tiles.size > 64) tiles.clear()
  tiles.set(key, c)
  return c
}

/**
 * A grain-textured paint for `ctx` in the CSS colour `css`, or the plain colour where patterns are
 * unavailable. `strength` 0..1 blends from a flat colour to full grain (soft grain keeps note text legible).
 */
export function grainPaint(ctx: Ctx2D, css: string, strength = 1, grain: Grain = 'chalk'): string | CanvasPattern {
  const tile = grainTile(css, strength, grain)
  const pattern = tile && ctx.createPattern(tile as CanvasImageSource, 'repeat')
  if (!pattern) return css
  const [cx, cy] = GRAINS[grain].cell
  if (typeof DOMMatrix !== 'undefined') pattern.setTransform(new DOMMatrix([cx, 0, 0, cy, 0, 0]))
  return pattern
}
