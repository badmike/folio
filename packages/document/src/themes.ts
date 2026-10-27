/**
 * Visual themes: render-time looks for a notebook. A theme never rewrites stored objects;
 * renderers resolve it into fonts, stroke treatment, shadows, texture and a palette
 * remap at draw time. Each theme has a light and a dark variant: the page's stored
 * background colour picks which one applies (see `themeVariant`).
 *
 * Users tune the knobs in `ThemeOptions` per theme; the overrides sync through the
 * workspace document, so every device renders a notebook the same way.
 */
import { CANVAS_BACKGROUNDS_DARK, CANVAS_BACKGROUNDS_LIGHT, PALETTE, adaptColor, defaultLineColor, isDarkColor, mixColors, parseHex } from './colors'
import type { FillStyle, FontFamily } from './types'

export const THEME_IDS = ['rough', 'clean', 'sketchnote', 'blueprint', 'chalkboard', 'whiteboard'] as const
export type ThemeId = (typeof THEME_IDS)[number]

export const HAND_LEVELS = ['refined', 'artist', 'sloppy'] as const
export type HandLevel = (typeof HAND_LEVELS)[number]

/** The knobs a user can customise per theme. */
export interface ThemeOptions {
  /** Font that replaces the base 'hand' family (text and shape / arrow labels). */
  font: FontFamily
  /** Render base-font text in capitals (stored text keeps its case). */
  uppercase: boolean
  /** Hard offset shadow under closed shapes and notes. */
  shadow: boolean
  /** Multiplier for shape and arrow stroke widths. */
  strokeScale: number
  /** Hand-drawn intensity 0..3 for shapes and arrows; null = each object's own roughness. Themes with hand levels ignore it. */
  roughness: number | null
  /** How the pen overdraws in themes with hand levels: lines past corners, retracing, pressure. */
  hand: HandLevel
  /** Paper colour new pages get on a light / dark app scheme. */
  paperLight: string
  paperDark: string
}

export type ThemeOverrides = Partial<ThemeOptions>
export type ThemeTexture = 'none' | 'chalk'

/**
 * How a theme's pen overdraws, set per theme (Settings > Themes > Overdraw): edges running
 * past their corners, retracing, pressure and weight.
 */
export interface Overdraw {
  /** How far edges run past their corners (world units). */
  overshoot: number
  /** Strokes retrace themselves (a second, slightly different pass). */
  multiStroke: boolean
  /** Stroke width variation along a line, 0..1 (0 = constant width): a felt marker's pressure. */
  widthJitter: number
  /** Stroke width multiplier on top of the theme's stroke weight. */
  weight: number
}

/** How much a shape wiggles, set per shape (its Sloppiness: Architect / Artist / Cartoonist, see handLevel). */
export interface Wiggle {
  /** roughjs intensity for curves, arrows and fills, and the tremble along drawn edges. */
  roughness: number
  /** Bow of an edge, as a fraction of its length. */
  bow: number
  /** How far corners stray from their exact position (world units). */
  skew: number
}

/** The theme's overdraw combined with a shape's wiggle: everything a hand needs to draw one object. */
export type HandProfile = Overdraw & Wiggle

/** Drawing styles of a theme with hand levels. */
export interface ThemeHands {
  overdraw: Record<HandLevel, Overdraw>
  wiggle: Record<HandLevel, Wiggle>
}

/**
 * How a theme paints one fill style (roughjs fill under the hood). Spacing and weight scale
 * with the shape's stroke width, so bolder pens shade with broader strokes.
 */
export interface FillLook {
  /** roughjs fill pattern. */
  pattern: 'solid' | 'hachure' | 'cross-hatch' | 'zigzag'
  /** Distance between fill strokes, in stroke widths (at least 4 world units). */
  gap: number
  /** Width of fill strokes, in stroke widths. */
  weight: number
  /** Stroke angle in degrees (roughjs default -41). */
  angle?: number
  /** Fill opacity; overlapping fill strokes build up darker, like markers. */
  opacity?: number
}

/** One colour scheme of a theme. `palette` null = colours adapt like the classic look (adaptColor). */
export interface ThemeVariant {
  ink: string
  shadow: string
  palette: ReadonlyMap<string, string> | null
}

export interface ThemePreset {
  id: ThemeId
  label: string
  description: string
  defaults: ThemeOptions
  /** Rough strokes retrace themselves (Excalidraw's double stroke) instead of one wobbly line (themes without hand levels). */
  multiStroke: boolean
  /** Overdraw and wiggle per level; absent = the theme has no levels (roughness applies). */
  hands?: ThemeHands
  /** How each fill style paints; absent styles draw as in Hand-drawn. */
  fills?: Partial<Record<FillStyle, FillLook>>
  texture: ThemeTexture
  light: ThemeVariant
  dark: ThemeVariant
}

/** A theme with the user's overrides applied: what renderers and the editor consume. */
export interface ResolvedTheme extends ThemeOptions {
  id: ThemeId
  multiStroke: boolean
  /** Overdraw and wiggle per level; null for themes without levels. */
  hands: ThemeHands | null
  /** How each fill style paints; absent styles draw as in Hand-drawn. */
  fills: Partial<Record<FillStyle, FillLook>>
  texture: ThemeTexture
  light: ThemeVariant
  dark: ThemeVariant
  /** Stable cache key: changes whenever anything that affects rendering changes. */
  key: string
}

type Shades = readonly [string, string, string, string, string]
type PaletteTable = Record<string, Shades>

/** Themed colour for every palette swatch, per hue in PALETTE order of shades (light to dark). */
const TABLES: Record<string, PaletteTable> = {
  sketchnoteLight: {
    black: ['#404040', '#404040', '#404040', '#111111', '#111111'],
    gray: ['#ececec', '#d7d7d7', '#b4b4b4', '#858585', '#404040'],
    white: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    bronze: ['#d6c9c4', '#c0aba2', '#ae9286', '#a18072', '#846358'],
    teal: ['#acedda', '#7ce5c5', '#55deb5', '#38d9a9', '#0c8599'],
    blue: ['#b5daf9', '#8ac7f8', '#67b7f7', '#4dabf7', '#1971c2'],
    violet: ['#d2c5fa', '#baa4fa', '#a689fa', '#9775fa', '#6741d9'],
    grape: ['#edc6f7', '#e5a5f5', '#df8bf3', '#da77f2', '#9c36b5'],
    pink: ['#f9cadb', '#f8adc7', '#f795b8', '#f783ac', '#c2255c'],
    green: ['#c0eec8', '#9ce6a8', '#7fe08f', '#69db7c', '#2f9e44'],
    cyan: ['#aee6ee', '#7edae6', '#58d0e0', '#3bc9db', '#0c8599'],
    yellow: ['#fceb96', '#fde157', '#feda25', '#ffd400', '#cc7803'],
    orange: ['#fcdab5', '#fdc58a', '#feb567', '#ffa94d', '#e8590c'],
    red: ['#fccccc', '#fdafaf', '#fe9898', '#ff8787', '#e03131'],
  },
  sketchnoteDark: {
    black: ['#c7c7c8', '#c7c7c8', '#c7c7c8', '#f2f2f2', '#f2f2f2'],
    gray: ['#29292b', '#3c3c3e', '#5c5c5e', '#878788', '#c7c7c8'],
    white: ['#2a2a2c', '#2a2a2c', '#2a2a2c', '#2a2a2c', '#2a2a2c'],
    bronze: ['#685249', '#86675a', '#9d7767', '#b48774', '#c7a394'],
    teal: ['#2b866c', '#30b08b', '#35cfa2', '#39efb9', '#64f7cb'],
    blue: ['#2b5d87', '#3077b0', '#358bd0', '#399eef', '#64b5f7'],
    violet: ['#422b87', '#5130b0', '#5c35d0', '#6739ef', '#8a64f7'],
    grape: ['#732b87', '#9630b0', '#b135d0', '#cb39ef', '#da64f7'],
    pink: ['#862b4c', '#b0305e', '#cf356b', '#ef3979', '#f76498'],
    green: ['#2b863b', '#30b046', '#35cf4e', '#39ef57', '#64f77c'],
    cyan: ['#2b7b87', '#30a1b0', '#35bdd0', '#39daef', '#64e6f7'],
    yellow: ['#87773f', '#b29b4c', '#d2b755', '#f2d25f', '#f7d764'],
    orange: ['#865a2c', '#b07231', '#cf8535', '#ef9739', '#f7b064'],
    red: ['#862b2c', '#b03031', '#cf3535', '#ef3939', '#f76464'],
  },
  blueprintLight: {
    black: ['#466088', '#466088', '#466088', '#1b3a6b', '#1b3a6b'],
    gray: ['#e6ecf3', '#d3dbe6', '#b2bed1', '#8799b4', '#466088'],
    white: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    bronze: ['#e6e4e5', '#dcd5d4', '#d2c7c3', '#b1978b', '#75594d'],
    teal: ['#d7f0ee', '#c3eae3', '#aee5d8', '#69d3b4', '#279b78'],
    blue: ['#d7e6f4', '#c3daee', '#aecee8', '#69a4d3', '#27679b'],
    violet: ['#dddbf4', '#ccc5ee', '#bcb0e8', '#8469d3', '#44279b'],
    grape: ['#e9dbf4', '#e1c5ee', '#d9b0e8', '#bf69d3', '#84279b'],
    pink: ['#eddbe6', '#e8c5d6', '#e3b0c5', '#d3698e', '#9b2750'],
    green: ['#d7f0e2', '#c3eacf', '#aee5bc', '#69d37b', '#279b3a'],
    cyan: ['#d7edf4', '#c3e6ee', '#aedfe8', '#69c7d3', '#278e9b'],
    yellow: ['#efeee5', '#ebe7d3', '#e8e1c2', '#ddca88', '#9b6b27'],
    orange: ['#ede6df', '#e8d9c9', '#e3ccb3', '#d3a069', '#9b6327'],
    red: ['#eddbdf', '#e8c5c9', '#e3b0b3', '#d36969', '#9b2727'],
  },
  blueprintDark: {
    black: ['#c9d6e8', '#c9d6e8', '#c9d6e8', '#f4f8ff', '#f4f8ff'],
    gray: ['#2a5993', '#3d689d', '#5e82af', '#89a3c6', '#c9d6e8'],
    white: ['#2b5a93', '#2b5a93', '#2b5a93', '#2b5a93', '#2b5a93'],
    bronze: ['#4e6e9a', '#6b81a2', '#8893aa', '#e0cbc3', '#e5d4cc'],
    teal: ['#407aa2', '#5593ae', '#69adbb', '#a8fae2', '#b4fde7'],
    blue: ['#4071a8', '#5585b8', '#6999c9', '#a8d5fa', '#b4ddfd'],
    violet: ['#4565a8', '#5d73b8', '#7580c9', '#bda8fa', '#c7b4fd'],
    grape: ['#5065a8', '#6f73b8', '#8e80c9', '#eaa8fa', '#efb4fd'],
    pink: ['#54659a', '#7573a3', '#9780ab', '#faa8c5', '#fdb4ce'],
    green: ['#407a97', '#55939d', '#69ada3', '#a8fab6', '#b4fdc1'],
    cyan: ['#4078a8', '#5590b8', '#69a8c9', '#a8f1fa', '#b4f5fd'],
    yellow: ['#55789d', '#7690a7', '#98a9b1', '#fcf2cf', '#fdedb4'],
    orange: ['#547093', '#758397', '#97979b', '#fad2a8', '#fddab4'],
    red: ['#546593', '#757397', '#97809b', '#faa8a8', '#fdb4b4'],
  },
  chalkboardLight: {
    black: ['#555c5b', '#555c5b', '#555c5b', '#33393a', '#33393a'],
    gray: ['#d5ddd6', '#c5cdc7', '#abb3ae', '#89908d', '#555c5b'],
    white: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    bronze: ['#cfcec6', '#c7c1b9', '#bfb5ac', '#a99389', '#766056'],
    teal: ['#bcddd0', '#abd9c9', '#99d4c1', '#6bc7ac', '#388d74'],
    blue: ['#bcd1d9', '#abc6d5', '#99bbd1', '#6b9ec7', '#386b94'],
    violet: ['#c3c2d9', '#b6afd5', '#a89dd1', '#836bc7', '#503894'],
    grape: ['#d2c2d9', '#ccafd5', '#c69dd1', '#b56bc7', '#823894'],
    pink: ['#d8c2c7', '#d4afba', '#d19dae', '#c76b8c', '#943859'],
    green: ['#bcddc1', '#abd9b2', '#99d4a3', '#6bc77a', '#389447'],
    cyan: ['#bcdad9', '#abd4d5', '#99ced1', '#6bbdc7', '#388a94'],
    yellow: ['#dbdcc6', '#d9d6b9', '#d7d1ac', '#d2c289', '#946e38'],
    orange: ['#d8d0bd', '#d4c5ab', '#d1b99a', '#c79b6b', '#946838'],
    red: ['#d8c2bd', '#d4afab', '#d19d9a', '#c76b6b', '#943838'],
  },
  chalkboardDark: {
    black: ['#c8cac1', '#c8cac1', '#c8cac1', '#f1efe6', '#f1efe6'],
    gray: ['#2e4337', '#415348', '#606f64', '#8a9389', '#c8cac1'],
    white: ['#2f4439', '#2f4439', '#2f4439', '#2f4439', '#2f4439'],
    bronze: ['#4e5a50', '#696f65', '#83847b', '#d3c2bb', '#dccdc6'],
    teal: ['#436456', '#567f6f', '#6a9988', '#a5e9d4', '#b1f1de'],
    blue: ['#435d5b', '#567278', '#6a8894', '#a5cae9', '#b1d5f1'],
    violet: ['#47535b', '#5d6478', '#737494', '#b6a5e9', '#c1b1f1'],
    grape: ['#50535b', '#6c6478', '#887494', '#dba5e9', '#e5b1f1'],
    pink: ['#545350', '#726466', '#8f747c', '#e9a5bd', '#f1b1c8'],
    green: ['#43644d', '#567f61', '#6a9975', '#a5e9b0', '#b1f1bc'],
    cyan: ['#43625b', '#567c78', '#6a9594', '#a5e1e9', '#b1eaf1'],
    yellow: ['#566452', '#757e6a', '#949881', '#f1e7c6', '#f1e3b1'],
    orange: ['#545c4a', '#72725c', '#8f876f', '#e9c8a5', '#f1d2b1'],
    red: ['#54534a', '#72645c', '#8f746f', '#e9a5a5', '#f1b1b1'],
  },
  whiteboardLight: {
    black: ['#4c5569', '#4c5569', '#4c5569', '#1f2a44', '#1f2a44'],
    gray: ['#f2f2f4', '#dddfe3', '#bcbfc7', '#8f94a2', '#4c5569'],
    white: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    bronze: ['#ebdfd9', '#dbc5bb', '#ccab9d', '#b07e68', '#936653'],
    teal: ['#c9fced', '#9dfade', '#71f8d0', '#25f4b6', '#19a784'],
    blue: ['#c9e5fc', '#9dd0fa', '#71bbf8', '#2597f4', '#177ccf'],
    violet: ['#d6c9fc', '#b59dfa', '#9471f8', '#5a25f4', '#4617cf'],
    grape: ['#f2c9fc', '#e89dfa', '#dd71f8', '#cb25f4', '#ab17cf'],
    pink: ['#fcc9db', '#fa9dbe', '#f871a1', '#f4256e', '#cf1758'],
    green: ['#c9fcd1', '#9dfaac', '#71f887', '#25f447', '#19a739'],
    cyan: ['#c9f6fc', '#9deffa', '#71e8f8', '#25dcf4', '#18a3b9'],
    yellow: ['#fdf3d2', '#fbeaae', '#f9e08b', '#f6d04c', '#cf8217'],
    orange: ['#fce3c9', '#facd9d', '#f8b771', '#f49025', '#cf7617'],
    red: ['#fcc9c9', '#fa9d9d', '#f87171', '#f42525', '#cf1717'],
  },
  whiteboardDark: {
    black: ['#bcc1c9', '#bcc1c9', '#bcc1c9', '#e8edf7', '#e8edf7'],
    gray: ['#1b1c20', '#2f3034', '#4f5257', '#7b7e85', '#bcc1c9'],
    white: ['#1c1d20', '#1c1d20', '#1c1d20', '#1c1d20', '#1c1d20'],
    bronze: ['#3a302d', '#54433d', '#6f574d', '#be917e', '#caa291'],
    teal: ['#1b4a3e', '#236d59', '#2b9073', '#42fac3', '#5cffce'],
    blue: ['#1b354c', '#234c6f', '#2b6392', '#42a8fa', '#5cb6ff'],
    violet: ['#271c4c', '#36236f', '#442b92', '#7142fa', '#865cff'],
    grape: ['#401c4c', '#5e236f', '#7c2b92', '#d642fa', '#df5cff'],
    pink: ['#491c2e', '#6c233f', '#902b50', '#fa4283', '#ff5c95'],
    green: ['#1b4a26', '#236d32', '#2b903d', '#42fa61', '#5cff77'],
    cyan: ['#1b454c', '#23656f', '#2b8592', '#42e5fa', '#5cedff'],
    yellow: ['#494228', '#6d6135', '#907f42', '#fbdb6a', '#ffdb5c'],
    orange: ['#49341e', '#6c4925', '#905f2c', '#faa142', '#ffb05c'],
    red: ['#491c1e', '#6c2325', '#902b2c', '#fa4242', '#ff5c5c'],
  },
}

/** Map every stored palette colour to its themed value; the first hue that lists a colour wins. */
function paletteMap(table: PaletteTable): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const hue of PALETTE) {
    const row = table[hue.name]
    if (!row) continue
    hue.shades.forEach((c, i) => { if (c !== 'transparent' && !map.has(c)) map.set(c, row[i]) })
  }
  return map
}

function variant(table: string | null, ink: string, shadow: string): ThemeVariant {
  return { ink, shadow, palette: table ? paletteMap(TABLES[table]) : null }
}

const pen = (o: Partial<Overdraw>): Overdraw => ({ overshoot: 0, multiStroke: false, widthJitter: 0, weight: 1, ...o })
const wiggle = (roughness: number, bow = 0, skew = 0): Wiggle => ({ roughness, bow, skew })

const CLASSIC_LIGHT = variant(null, '#1e1e1e', '#00000038')
const CLASSIC_DARK = variant(null, '#e3e3e3', '#00000080')

export const THEME_PRESETS: Record<ThemeId, ThemePreset> = {
  rough: {
    id: 'rough', label: 'Hand-drawn', description: 'Excalidraw-style sketchy shapes and the hand-drawn font.',
    defaults: {
      font: 'hand', uppercase: false, shadow: false, strokeScale: 1, roughness: null, hand: 'artist',
      paperLight: CANVAS_BACKGROUNDS_LIGHT[0], paperDark: CANVAS_BACKGROUNDS_DARK[0],
    },
    multiStroke: true, texture: 'none', light: CLASSIC_LIGHT, dark: CLASSIC_DARK,
  },
  clean: {
    id: 'clean', label: 'Clean', description: 'Straight geometric shapes and the system font.',
    defaults: {
      font: 'sans', uppercase: false, shadow: false, strokeScale: 1, roughness: 0, hand: 'artist',
      paperLight: CANVAS_BACKGROUNDS_LIGHT[0], paperDark: CANVAS_BACKGROUNDS_DARK[0],
    },
    multiStroke: false, texture: 'none', light: CLASSIC_LIGHT, dark: CLASSIC_DARK,
  },
  sketchnote: {
    id: 'sketchnote', label: 'Sketchnote', description: 'Bold marker outlines, offset shadows, flat colour and capitals.',
    defaults: {
      font: 'gochi', uppercase: true, shadow: true, strokeScale: 1.75, roughness: 1, hand: 'artist',
      paperLight: '#fafafa', paperDark: '#1c1c1e',
    },
    // felt marker: every edge its own bowed stroke running past the corners, width varying with pressure
    hands: {
      overdraw: {
        refined: pen({ overshoot: 2, widthJitter: 0.12 }),
        artist: pen({ overshoot: 6, widthJitter: 0.25 }),
        sloppy: pen({ overshoot: 12, widthJitter: 0.4, weight: 1.1 }),
      },
      wiggle: { refined: wiggle(0.5, 0.006, 1), artist: wiggle(1, 0.013, 2.5), sloppy: wiggle(1.8, 0.024, 6) },
    },
    // flat colour as in the picture; hatching is done with the same bold marker
    fills: {
      hachure: { pattern: 'hachure', gap: 3, weight: 0.9 },
      'cross-hatch': { pattern: 'cross-hatch', gap: 3.5, weight: 0.8 },
    },
    multiStroke: false, texture: 'none',
    light: variant('sketchnoteLight', '#111111', '#a3a3a3'),
    dark: variant('sketchnoteDark', '#f2f2f2', '#000000'),
  },
  blueprint: {
    id: 'blueprint', label: 'Blueprint', description: 'Clean technical lines and draftsman lettering on blueprint paper.',
    defaults: {
      font: 'architect', uppercase: true, shadow: false, strokeScale: 0.8, roughness: 0, hand: 'artist',
      paperLight: '#f3f7fc', paperDark: '#1d4f8c',
    },
    // draftsman: a fine pen; overdrawing lets construction lines run past the corners, an
    // architect's shape is ruled exactly and an artist's is gently hand-ruled
    hands: {
      overdraw: { refined: pen({ weight: 0.75 }), artist: pen({ overshoot: 3 }), sloppy: pen({ overshoot: 9 }) },
      wiggle: { refined: wiggle(0), artist: wiggle(0.3, 0.003, 0.5), sloppy: wiggle(0.7, 0.007, 1.5) },
    },
    // section hatching: fine, even 45° lines; a solid fill is a translucent wash
    fills: {
      hachure: { pattern: 'hachure', gap: 3.5, weight: 0.4, angle: -45 },
      'cross-hatch': { pattern: 'cross-hatch', gap: 4.5, weight: 0.35, angle: -45 },
      solid: { pattern: 'solid', gap: 0, weight: 0, opacity: 0.45 },
    },
    multiStroke: false, texture: 'none',
    light: variant('blueprintLight', '#1b3a6b', '#1b3a6b33'),
    dark: variant('blueprintDark', '#f4f8ff', '#0b2a5280'),
  },
  chalkboard: {
    id: 'chalkboard', label: 'Chalkboard', description: 'Grainy chalk strokes on a slate board.',
    defaults: {
      font: 'kalam', uppercase: false, shadow: false, strokeScale: 1.5, roughness: 1.6, hand: 'artist',
      paperLight: '#dfe7e0', paperDark: '#22382c',
    },
    // chalk overdraws by going over a line twice
    hands: {
      overdraw: { refined: pen({}), artist: pen({ multiStroke: true }), sloppy: pen({ multiStroke: true, overshoot: 6, widthJitter: 0.3 }) },
      wiggle: { refined: wiggle(0.9), artist: wiggle(1.6), sloppy: wiggle(2.6, 0.016, 4) },
    },
    // chalk has no flat fill: a solid is shaded with the side of the chalk in a dense scribble
    fills: {
      hachure: { pattern: 'hachure', gap: 3, weight: 0.9, angle: -35 },
      'cross-hatch': { pattern: 'cross-hatch', gap: 4, weight: 0.8, angle: -35 },
      solid: { pattern: 'zigzag', gap: 1.4, weight: 1.6, angle: -30, opacity: 0.85 },
    },
    multiStroke: true, texture: 'chalk',
    light: variant('chalkboardLight', '#33393a', '#00000030'),
    dark: variant('chalkboardDark', '#f1efe6', '#00000066'),
  },
  whiteboard: {
    id: 'whiteboard', label: 'Whiteboard', description: 'Thick dry-erase marker strokes in saturated colours.',
    defaults: {
      font: 'patrick', uppercase: false, shadow: false, strokeScale: 2, roughness: 0.5, hand: 'artist',
      paperLight: '#ffffff', paperDark: '#0e0f12',
    },
    hands: {
      overdraw: { refined: pen({ weight: 0.85 }), artist: pen({ widthJitter: 0.1 }), sloppy: pen({ overshoot: 7, widthJitter: 0.3, weight: 1.05 }) },
      wiggle: { refined: wiggle(0.2), artist: wiggle(0.5), sloppy: wiggle(1.2, 0.016, 4) },
    },
    // a dry-erase marker cannot fill flat: broad translucent strokes that darken where they overlap
    fills: {
      hachure: { pattern: 'hachure', gap: 2.5, weight: 1, angle: -42, opacity: 0.8 },
      'cross-hatch': { pattern: 'cross-hatch', gap: 3, weight: 0.9, angle: -42, opacity: 0.7 },
      solid: { pattern: 'hachure', gap: 0.8, weight: 1.4, angle: -42, opacity: 0.75 },
    },
    multiStroke: false, texture: 'none',
    light: variant('whiteboardLight', '#1f2a44', '#00000030'),
    dark: variant('whiteboardDark', '#e8edf7', '#00000080'),
  },
}

export const DEFAULT_THEME: ThemeId = 'rough'

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v)
}

const STROKE_SCALE: readonly [number, number] = [0.5, 3]
const ROUGHNESS: readonly [number, number] = [0, 3]
const FONT_FAMILIES: readonly FontFamily[] = [
  'hand', 'sans', 'mono', 'caveat', 'kalam', 'patrick', 'indie', 'architect', 'shadows', 'gloria', 'marker', 'playpen', 'gochi',
]

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v))
const isOpaqueHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) && !!parseHex(v)

/** Keep only well-formed overrides (they arrive through sync, so treat them as untrusted). */
export function sanitizeThemeOverrides(raw: unknown): ThemeOverrides {
  const out: ThemeOverrides = {}
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (typeof r.font === 'string' && (FONT_FAMILIES as readonly string[]).includes(r.font)) out.font = r.font as FontFamily
  if (typeof r.uppercase === 'boolean') out.uppercase = r.uppercase
  if (typeof r.shadow === 'boolean') out.shadow = r.shadow
  if (typeof r.strokeScale === 'number' && Number.isFinite(r.strokeScale)) out.strokeScale = clamp(r.strokeScale, STROKE_SCALE)
  if (r.roughness === null) out.roughness = null
  else if (typeof r.roughness === 'number' && Number.isFinite(r.roughness)) out.roughness = clamp(r.roughness, ROUGHNESS)
  if (typeof r.hand === 'string' && (HAND_LEVELS as readonly string[]).includes(r.hand)) out.hand = r.hand as HandLevel
  if (isOpaqueHex(r.paperLight)) out.paperLight = r.paperLight.toLowerCase()
  if (isOpaqueHex(r.paperDark)) out.paperDark = r.paperDark.toLowerCase()
  return out
}

/** Apply (sanitised) overrides to a preset. Unknown ids fall back to the default theme. */
export function resolveTheme(id: ThemeId | string | undefined, overrides?: unknown): ResolvedTheme {
  const preset = THEME_PRESETS[isThemeId(id) ? id : DEFAULT_THEME]
  const options: ThemeOptions = { ...preset.defaults, ...sanitizeThemeOverrides(overrides) }
  const key = [preset.id, ...Object.values(options)].join('|')
  return {
    ...options, id: preset.id, multiStroke: preset.multiStroke, hands: preset.hands ?? null, fills: preset.fills ?? {},
    texture: preset.texture, light: preset.light, dark: preset.dark, key,
  }
}

/** Hand level of an object's sloppiness: Architect (0) draws refined, Artist (1) as the artist, Cartoonist (2) sloppy. */
export function handLevel(roughness: number): HandLevel {
  return roughness < 0.5 ? 'refined' : roughness < 1.5 ? 'artist' : 'sloppy'
}

const profiles = new Map<string, HandProfile>()

/**
 * How the theme draws an object with this sloppiness: the theme's overdraw with the shape's
 * wiggle on top. null when the theme has no hand levels.
 */
export function handFor(theme: ResolvedTheme, roughness: number): HandProfile | null {
  if (!theme.hands) return null
  const level = handLevel(roughness)
  const key = `${theme.id}|${theme.hand}|${level}`
  let p = profiles.get(key)
  if (!p) profiles.set(key, (p = { ...theme.hands.overdraw[theme.hand], ...theme.hands.wiggle[level] }))
  return p
}

/** Whether objects' own sloppiness changes how they draw under the theme. */
export function honoursSloppiness(theme: ResolvedTheme): boolean {
  return !!theme.hands || theme.roughness === null
}

/** The variant that applies on a page with `background`. */
export function themeVariant(theme: ResolvedTheme, background: string): ThemeVariant {
  return isDarkColor(background) ? theme.dark : theme.light
}

/** Colour to DISPLAY for a stored colour on `background` under `theme`. */
export function themeColor(theme: ResolvedTheme, color: string, background: string): string {
  if (!color || color === 'transparent') return color
  const mapped = themeVariant(theme, background).palette?.get(color.toLowerCase())
  return mapped ?? adaptColor(color, background)
}

/** Paper colour of the theme for a light or dark page. */
export function themePaper(theme: ResolvedTheme, dark: boolean): string {
  return dark ? theme.paperDark : theme.paperLight
}

/** Pattern line colour for theme paper: a faint tint of the theme ink (classic themes keep the grey default). */
export function themeLineColor(theme: ResolvedTheme, paper: string): string {
  const v = themeVariant(theme, paper)
  return v.palette ? mixColors(paper, v.ink, 0.18) : defaultLineColor(paper)
}
