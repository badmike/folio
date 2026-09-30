/**
 * Colour palette (Excalidraw / open-color based) and canvas-aware colour
 * adaptation. Colours are stored in the document exactly as picked; renderers
 * and UI previews call `adaptColor()` so content stays legible on any page
 * background (e.g. "black" ink shows as near-white on a dark page) without
 * rewriting the document.
 */

export interface PaletteHue {
  name: string
  /** 5 shades from light to dark; index DEFAULT_SHADE is the swatch colour. */
  shades: [string, string, string, string, string]
}

export const DEFAULT_SHADE = 3

/** Hue grid shown in the colour picker (row-major, 5 per row). */
export const PALETTE: PaletteHue[] = [
  { name: 'transparent', shades: ['transparent', 'transparent', 'transparent', 'transparent', 'transparent'] },
  { name: 'black', shades: ['#343a40', '#343a40', '#343a40', '#1e1e1e', '#1e1e1e'] },
  { name: 'gray', shades: ['#f8f9fa', '#e9ecef', '#ced4da', '#868e96', '#343a40'] },
  { name: 'white', shades: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'] },
  { name: 'bronze', shades: ['#f8f1ee', '#eaddd7', '#d2bab0', '#a18072', '#846358'] },
  { name: 'teal', shades: ['#c3fae8', '#96f2d7', '#63e6be', '#38d9a9', '#0c8599'] },
  { name: 'blue', shades: ['#d0ebff', '#a5d8ff', '#74c0fc', '#4dabf7', '#1971c2'] },
  { name: 'violet', shades: ['#e5dbff', '#d0bfff', '#b197fc', '#9775fa', '#6741d9'] },
  { name: 'grape', shades: ['#f3d9fa', '#eebefa', '#e599f7', '#da77f2', '#9c36b5'] },
  { name: 'pink', shades: ['#ffdeeb', '#fcc2d7', '#faa2c1', '#f783ac', '#c2255c'] },
  { name: 'green', shades: ['#d3f9d8', '#b2f2bb', '#8ce99a', '#69db7c', '#2f9e44'] },
  { name: 'cyan', shades: ['#c5f6fa', '#99e9f2', '#66d9e8', '#3bc9db', '#0c8599'] },
  { name: 'yellow', shades: ['#fff9db', '#ffec99', '#ffe066', '#ffd43b', '#f08c00'] },
  { name: 'orange', shades: ['#fff4e6', '#ffd8a8', '#ffc078', '#ffa94d', '#e8590c'] },
  { name: 'red', shades: ['#fff5f5', '#ffc9c9', '#ffa8a8', '#ff8787', '#e03131'] },
]

/** Quick-pick swatches shown inline in the properties panel (defaults; notebooks can override them). */
export const QUICK_STROKE_COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00'] as const
export const QUICK_BACKGROUND_COLORS = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99'] as const
export const QUICK_HIGHLIGHTER_COLORS = ['#ffd43b', '#69db7c', '#74c0fc', '#f783ac', '#ffa94d'] as const

export interface QuickColorSets {
  stroke: readonly string[]
  background: readonly string[]
  highlighter: readonly string[]
}

export function defaultQuickColors(): QuickColorSets {
  return { stroke: QUICK_STROKE_COLORS, background: QUICK_BACKGROUND_COLORS, highlighter: QUICK_HIGHLIGHTER_COLORS }
}

/** Page/canvas background presets. */
export const CANVAS_BACKGROUNDS_LIGHT = ['#ffffff', '#f8f9fa', '#f5faff', '#fffce8', '#fdf8f6'] as const
export const CANVAS_BACKGROUNDS_DARK = ['#121212', '#161718', '#13171c', '#181605', '#1b1615'] as const

// ---------------------------------------------------------------------------

export interface RGB { r: number; g: number; b: number; a: number }

export function parseHex(color: string): RGB | null {
  const c = color.trim().toLowerCase()
  if (c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  let m = /^#([0-9a-f]{3,8})$/.exec(c)
  if (!m) return null
  let h = m[1]
  if (h.length === 3 || h.length === 4) h = h.split('').map(ch => ch + ch).join('')
  if (h.length !== 6 && h.length !== 8) return null
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
}

export function toHex({ r, g, b, a }: RGB): string {
  const x = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  return `#${x(r)}${x(g)}${x(b)}${a < 1 ? x(a * 255) : ''}`
}

/** WCAG relative luminance 0..1. */
export function luminance(color: string): number {
  const c = parseHex(color)
  if (!c) return 1
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function isDarkColor(color: string): boolean {
  return luminance(color) < 0.18
}

function rgbToHsl({ r, g, b }: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number, a: number): RGB {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255, a }
}

const adaptCache = new Map<string, string>()

/**
 * Map a stored colour to the colour to DISPLAY on `background`.
 * - Light backgrounds: returned unchanged (the palette is designed for them).
 * - Dark backgrounds: lightness is mirrored (Excalidraw-style invert that keeps
 *   hue), so near-black ink becomes near-white and pastel fills become deep,
 *   muted fills; saturated mid colours are nudged lighter until they reach a
 *   minimum contrast of 3:1.
 * 'transparent' and unparsable values pass through.
 */
export function adaptColor(color: string, background: string): string {
  if (!color || color === 'transparent') return color
  if (!isDarkColor(background)) return color
  const key = color + '|' + background
  const hit = adaptCache.get(key)
  if (hit) return hit
  const rgb = parseHex(color)
  if (!rgb) return color
  const [h, s, l] = rgbToHsl(rgb)
  let nl = 1 - l
  // keep saturated colours vivid: mirror less aggressively around the middle
  if (s > 0.35) nl = Math.max(nl, 0.55 + (l - 0.5) * 0.3)
  let out = toHex(hslToRgb(h, s * (s > 0.35 ? 0.9 : 1), Math.min(0.95, nl), rgb.a))
  for (let i = 0; i < 8 && contrastRatio(out, background) < 3 && rgb.a > 0; i++) {
    nl = Math.min(0.95, nl + 0.06)
    out = toHex(hslToRgb(h, s, nl, rgb.a))
  }
  if (adaptCache.size > 2048) adaptCache.clear()
  adaptCache.set(key, out)
  return out
}

/** Colour of UI chrome / pattern lines that reads well on `background`. */
export function defaultLineColor(background: string): string {
  return isDarkColor(background) ? '#3a3f45' : '#c9ced6'
}
