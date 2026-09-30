import { DEFAULT_SHADE, PALETTE, type PaletteHue } from '@folio/document'

/** Keyboard hints of the colour grid (row-major, matching PALETTE order): Excalidraw's q w e r t / a s d f g / z x c v b. */
export const GRID_KEYS = ['q', 'w', 'e', 'r', 't', 'a', 's', 'd', 'f', 'g', 'z', 'x', 'c', 'v', 'b'] as const

/** Hues that have no meaningful shades. */
const NO_SHADES = new Set(['transparent', 'black', 'white'])

/** Validate and canonicalise a hex code typed by the user ('#'-less or not). Returns null when invalid. */
export function normalizeHex(input: string): string | null {
  const t = input.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(t)) return '#' + t.split('').map((c) => c + c).join('')
  if (/^[0-9a-f]{6}$/.test(t)) return '#' + t
  if (/^[0-9a-f]{8}$/.test(t)) return '#' + t
  return null
}

/** The palette hue (and shade index) a colour belongs to, if any. */
export function findInPalette(color: string): { hue: PaletteHue; index: number; shade: number } | null {
  const c = color.trim().toLowerCase()
  // prefer the hue whose *default* swatch is this colour, then any shade match
  let fallback: { hue: PaletteHue; index: number; shade: number } | null = null
  for (let i = 0; i < PALETTE.length; i++) {
    const hue = PALETTE[i]
    if (hue.shades[DEFAULT_SHADE].toLowerCase() === c) return { hue, index: i, shade: DEFAULT_SHADE }
    const s = hue.shades.findIndex((x) => x.toLowerCase() === c)
    if (s >= 0 && !fallback && !NO_SHADES.has(hue.name)) fallback = { hue, index: i, shade: s }
  }
  return fallback
}

/** Shades to show for the current colour ([] = "No shades available for this color"). */
export function shadesFor(color: string): string[] {
  const hit = findInPalette(color)
  if (!hit || NO_SHADES.has(hit.hue.name)) return []
  return [...hit.hue.shades]
}

/** Colour applied when a hue is chosen: keeps the current shade index when the current colour is a palette shade. */
export function colorForHue(hueIndex: number, current: string): string {
  const hue = PALETTE[hueIndex]
  if (NO_SHADES.has(hue.name)) return hue.shades[DEFAULT_SHADE]
  const cur = findInPalette(current)
  const shade = cur && !NO_SHADES.has(cur.hue.name) ? cur.shade : DEFAULT_SHADE
  return hue.shades[shade]
}

export function sameColor(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}
