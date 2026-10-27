/**
 * Chalk grain: a deterministic speckle that breaks strokes, fills and text into dry chalk.
 * The same function drives the Canvas2D pattern tile and the WebGL mesh shader (GRAIN_GLSL),
 * so both renderers and exports show the same texture. Grain lives in object space:
 * it moves, scales and rotates with the object instead of swimming across it.
 */
import { parseColor } from './color'
import type { Ctx2D } from './textdraw'

/** Size of one grain cell in object units. */
export const GRAIN_CELL = 0.6
/** The texture repeats every GRAIN_TILE cells. */
export const GRAIN_TILE = 128

const hash = (x: number, y: number): number => {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return v - Math.floor(v)
}

/** Opacity factor (0..1) of the grain cell (cx, cy), both in 0..GRAIN_TILE-1. */
export function grainAt(cx: number, cy: number): number {
  const fine = hash(cx, cy)
  const coarse = hash(Math.floor(cx / 6) + 17, Math.floor(cy / 6) + 17)
  return fine > 0.3 ? 0.55 + 0.45 * coarse : 0.15 * coarse
}

/** GLSL twin of grainAt; `p` = object-space position. */
export const GRAIN_GLSL = `
float grainHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float grain(vec2 p) {
  vec2 c = mod(floor(p / ${GRAIN_CELL.toFixed(2)}), ${GRAIN_TILE.toFixed(1)});
  float fine = grainHash(c);
  float coarse = grainHash(floor(c / 6.0) + 17.0);
  return fine > 0.3 ? 0.55 + 0.45 * coarse : 0.15 * coarse;
}`

let alphaTile: Uint8ClampedArray | null = null

function tileAlpha(): Uint8ClampedArray {
  if (alphaTile) return alphaTile
  alphaTile = new Uint8ClampedArray(GRAIN_TILE * GRAIN_TILE)
  for (let y = 0; y < GRAIN_TILE; y++) for (let x = 0; x < GRAIN_TILE; x++) alphaTile[y * GRAIN_TILE + x] = Math.round(grainAt(x, y) * 255)
  return alphaTile
}

const tiles = new Map<string, HTMLCanvasElement | OffscreenCanvas>()

function grainTile(css: string, strength: number): HTMLCanvasElement | OffscreenCanvas | null {
  const key = `${css}|${strength}`
  const hit = tiles.get(key)
  if (hit) return hit
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(GRAIN_TILE, GRAIN_TILE) : typeof document !== 'undefined' ? document.createElement('canvas') : null
  if (!c) return null
  c.width = GRAIN_TILE
  c.height = GRAIN_TILE
  const ctx = c.getContext('2d') as Ctx2D | null
  if (!ctx || typeof ImageData === 'undefined') return null
  const a = tileAlpha()
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
 * A chalk-textured paint for `ctx` in the CSS colour `css`, or the plain colour where patterns are
 * unavailable. `strength` 0..1 blends from a flat colour to full grain (soft grain keeps note text legible).
 */
export function chalkPaint(ctx: Ctx2D, css: string, strength = 1): string | CanvasPattern {
  const tile = grainTile(css, strength)
  const pattern = tile && ctx.createPattern(tile as CanvasImageSource, 'repeat')
  if (!pattern) return css
  if (typeof DOMMatrix !== 'undefined') pattern.setTransform(new DOMMatrix([GRAIN_CELL, 0, 0, GRAIN_CELL, 0, 0]))
  return pattern
}
