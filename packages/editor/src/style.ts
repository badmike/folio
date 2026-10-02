/**
 * Pure style logic behind the Excalidraw-style properties panel: which
 * properties apply to which object types, reading common values from a
 * selection and building object patches from a StylePatch.
 */
import { DEFAULT_LABEL_SIZE, DEFAULT_BLUR_SIZE } from '@folio/document'
import type { ArrowObject, CanvasObject, FillStyle, ObjectPatch, ShapeObject, ShapeStyle, StrokeStyle } from '@folio/document'
import { COUNTER_SIZE_PER_FONT, HIGHLIGHTER_WIDTH_PRESETS, PEN_WIDTH_PRESETS, STROKE_WIDTH_PRESETS } from './types'
import type { ItemStyle, StyleContext, StyleProp, StylePatch, Tool, ToolOptionsMap } from './types'

export function defaultItemStyle(): ItemStyle {
  return {
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'hachure',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 1,
    fontFamily: 'hand',
    fontSize: 20,
    textAlign: 'left',
    arrowType: 'straight',
    startHead: 'none',
    endHead: 'arrow',
    roundness: 'sharp',
    blurSize: DEFAULT_BLUR_SIZE,
    blurMode: 'pixelate',
    counterStyle: 'pin',
  }
}

const INK_PROPS: StyleProp[] = ['strokeColor', 'strokeWidth', 'opacity']
const HIGHLIGHTER_PROPS: StyleProp[] = ['strokeColor', 'strokeWidth', 'cap', 'opacity']
const BOX_PROPS: StyleProp[] = ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roundness', 'roughness', 'opacity']
const SHAPE_PROPS: StyleProp[] = BOX_PROPS.filter((p) => p !== 'roundness')
const LINE_PROPS: StyleProp[] = SHAPE_PROPS.filter((p) => p !== 'backgroundColor' && p !== 'fillStyle')
const ARROW_PROPS: StyleProp[] = [
  'strokeColor', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'arrowType', 'startHead', 'endHead',
]
const TEXT_PROPS: StyleProp[] = ['strokeColor', 'fontFamily', 'fontSize', 'textAlign', 'opacity']
const FRAME_PROPS: StyleProp[] = ['fontSize']
const BLUR_PROPS: StyleProp[] = ['blurMode', 'blurSize', 'opacity']
/** Notes are text on a box: the background is the box colour. */
const NOTE_PROPS: StyleProp[] = ['strokeColor', 'backgroundColor', 'fontFamily', 'fontSize', 'textAlign', 'opacity']
/** Counters: number colour, pin colour, size (the font size presets) and opacity. */
const COUNTER_PROPS: StyleProp[] = ['counterStyle', 'strokeColor', 'backgroundColor', 'fontFamily', 'fontSize', 'opacity']
/** Canonical property order for the panel. */
const ORDER: StyleProp[] = [
  'counterStyle', 'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'cap', 'strokeStyle', 'roundness', 'roughness', 'blurMode', 'blurSize', 'fontFamily', 'fontSize',
  'textAlign', 'arrowType', 'startHead', 'endHead', 'opacity',
]

/** Shapes whose corners can be rounded. */
export function hasCorners(kind: ShapeObject['kind']): boolean {
  return kind === 'rectangle' || kind === 'triangle' || kind === 'diamond'
}

export function applicableFor(o: CanvasObject): StyleProp[] {
  switch (o.type) {
    case 'ink': return o.style.tool === 'highlighter' ? HIGHLIGHTER_PROPS : INK_PROPS
    case 'shape':
      if (o.kind === 'line') return LINE_PROPS
      if (o.kind === 'frame') return FRAME_PROPS
      if (o.kind === 'blur') return BLUR_PROPS
      if (o.kind === 'counter') return COUNTER_PROPS
      // labelled boxes also expose the label size
      return [...(hasCorners(o.kind) ? BOX_PROPS : SHAPE_PROPS), ...(o.label ? ['fontSize' as const] : [])]
    case 'arrow': return o.label ? [...ARROW_PROPS, 'fontSize'] : ARROW_PROPS
    case 'text': return o.background ? NOTE_PROPS : TEXT_PROPS
    default: return []
  }
}

export function toolApplicable(tool: Tool, shapeKind?: ShapeObject['kind']): StyleProp[] {
  switch (tool) {
    case 'pen': return INK_PROPS
    case 'highlighter': return HIGHLIGHTER_PROPS
    case 'shape': return shapeKind === 'line' ? LINE_PROPS : shapeKind && !hasCorners(shapeKind) ? SHAPE_PROPS : BOX_PROPS
    case 'arrow': return ARROW_PROPS
    case 'text': return TEXT_PROPS
    case 'blur': return BLUR_PROPS
    case 'note': return NOTE_PROPS
    case 'counter': return COUNTER_PROPS
    default: return []
  }
}

/** Ink stroke width <-> shared 1/2/4 stroke-width preset space. */
export function inkPresets(tool: StrokeStyle['tool']): readonly number[] {
  return tool === 'highlighter' ? HIGHLIGHTER_WIDTH_PRESETS : PEN_WIDTH_PRESETS
}

function nearestIndex(list: readonly number[], v: number): number {
  let best = 0
  for (let i = 1; i < list.length; i++) if (Math.abs(list[i] - v) < Math.abs(list[best] - v)) best = i
  return best
}

/** Shape-space strokeWidth (1/2/4) shown for an ink width. */
export function inkWidthToStroke(tool: StrokeStyle['tool'], width: number): number {
  return STROKE_WIDTH_PRESETS[nearestIndex(inkPresets(tool), width)]
}

/** Ink width for a shape-space strokeWidth. */
export function strokeToInkWidth(tool: StrokeStyle['tool'], strokeWidth: number): number {
  return inkPresets(tool)[nearestIndex(STROKE_WIDTH_PRESETS, strokeWidth)]
}

export function defaultFillStyle(s: ShapeStyle): FillStyle {
  return s.fillStyle ?? (s.roughness === 0 ? 'solid' : 'hachure')
}

export type StyleValue = ItemStyle[keyof ItemStyle] | StrokeStyle['cap']

/** The value of a style property on an object, if the property applies. */
export function readProp(o: CanvasObject, p: StyleProp): StyleValue | undefined {
  switch (o.type) {
    case 'ink':
      if (p === 'strokeColor') return o.style.color
      if (p === 'strokeWidth') return inkWidthToStroke(o.style.tool, o.style.width)
      if (p === 'opacity') return o.style.opacity
      if (p === 'cap') return o.style.tool === 'highlighter' ? o.style.cap ?? 'flat' : undefined
      return undefined
    case 'shape':
    case 'arrow': {
      const s = o.style
      switch (p) {
        case 'strokeColor': return s.strokeColor
        case 'backgroundColor': return o.type === 'shape' ? s.fillColor || 'transparent' : undefined
        case 'fillStyle': return o.type === 'shape' ? defaultFillStyle(s) : undefined
        case 'strokeWidth': return s.strokeWidth
        case 'strokeStyle': return s.strokeStyle ?? 'solid'
        case 'roundness': return o.type === 'shape' && hasCorners(o.kind) ? s.roundness ?? 'sharp' : undefined
        case 'roughness': return s.roughness
        case 'opacity': return s.opacity
        case 'fontFamily': return o.type === 'shape' && o.kind === 'counter' ? o.fontFamily ?? 'sans' : undefined
        case 'counterStyle': return o.type === 'shape' && o.kind === 'counter' ? o.counterStyle ?? 'pin' : undefined
        case 'fontSize':
          if (o.type === 'shape' && o.kind === 'counter') return Math.round(Math.min(o.width, o.height) / COUNTER_SIZE_PER_FONT)
          return o.labelSize ?? DEFAULT_LABEL_SIZE
        case 'blurSize': return o.type === 'shape' && o.kind === 'blur' ? o.blurSize ?? DEFAULT_BLUR_SIZE : undefined
        case 'blurMode': return o.type === 'shape' && o.kind === 'blur' ? o.blurMode ?? 'pixelate' : undefined
        case 'arrowType': return o.type === 'arrow' ? o.arrowType ?? 'straight' : undefined
        case 'startHead': return o.type === 'arrow' ? o.startHead : undefined
        case 'endHead': return o.type === 'arrow' ? o.endHead : undefined
        default: return undefined
      }
    }
    case 'text':
      switch (p) {
        case 'strokeColor': return o.color
        case 'backgroundColor': return o.background ? o.background : undefined
        case 'fontFamily': return o.fontFamily
        case 'fontSize': return o.fontSize
        case 'textAlign': return o.align ?? 'left'
        case 'opacity': return o.opacity ?? 1
        default: return undefined
      }
    default: return undefined
  }
}

/** Context for a non-empty selection of leaf objects. */
export function selectionContext(leaves: CanvasObject[], canvasBackground: string): StyleContext {
  const applicable = new Set<StyleProp>()
  for (const o of leaves) for (const p of applicableFor(o)) applicable.add(p)
  const list = ORDER.filter((p) => applicable.has(p))
  const values: StyleContext['values'] = {}
  for (const p of list) {
    let common: unknown
    let seen = false
    for (const o of leaves) {
      const v = readProp(o, p)
      if (v === undefined) continue
      if (!seen) { common = v; seen = true } else if (common !== v) { common = 'mixed'; break }
    }
    if (seen) (values as Record<string, unknown>)[p] = common
  }
  return {
    source: 'selection', applicable: list, values, types: [...new Set(leaves.map((o) => o.type))], canvasBackground,
  }
}

/** Context for the active tool when nothing is selected. */
export function toolContext(tool: Tool, item: ItemStyle, opts: ToolOptionsMap, canvasBackground: string): StyleContext {
  const applicable = toolApplicable(tool, opts.shape.kind)
  const values: StyleContext['values'] = {}
  if (tool === 'pen' || tool === 'highlighter') {
    const o = opts[tool]
    values.strokeColor = o.color
    values.strokeWidth = inkWidthToStroke(tool, o.width)
    values.opacity = o.opacity
    if (tool === 'highlighter') values.cap = o.cap ?? 'flat'
  } else {
    for (const p of applicable) if (p !== 'cap') (values as Record<string, unknown>)[p] = item[p]
  }
  return { source: 'tool', applicable: [...applicable], values, types: [], canvasBackground }
}

/**
 * Build the object patch that applies `patch` to `o` (undefined = nothing to
 * change). `rawInkWidth` skips the preset mapping for ink (legacy setSelectionStyle).
 */
export function patchForObject(o: CanvasObject, patch: StylePatch, rawInkWidth = false): ObjectPatch | undefined {
  switch (o.type) {
    case 'ink': {
      const style = { ...o.style }
      if (patch.strokeColor !== undefined) style.color = patch.strokeColor
      if (patch.strokeWidth !== undefined) style.width = rawInkWidth ? patch.strokeWidth : strokeToInkWidth(style.tool, patch.strokeWidth)
      if (patch.opacity !== undefined) style.opacity = patch.opacity
      if (patch.cap !== undefined && style.tool === 'highlighter') style.cap = patch.cap
      return same(style, o.style) ? undefined : ({ style } as ObjectPatch)
    }
    case 'shape':
    case 'arrow': {
      const isFrame = o.type === 'shape' && o.kind === 'frame'
      const isBlur = o.type === 'shape' && o.kind === 'blur'
      const style: ShapeStyle = { ...o.style }
      const out: ObjectPatch = {}
      let changed = false
      if (!isFrame) {
        if (patch.strokeColor !== undefined) style.strokeColor = patch.strokeColor
        if (patch.strokeWidth !== undefined) style.strokeWidth = patch.strokeWidth
        if (patch.strokeStyle !== undefined) style.strokeStyle = patch.strokeStyle
        if (patch.roughness !== undefined) style.roughness = patch.roughness
        if (patch.opacity !== undefined) style.opacity = patch.opacity
      }
      if (o.type === 'shape' && !isFrame && !isBlur) {
        if (patch.backgroundColor !== undefined) {
          if (patch.backgroundColor === 'transparent') delete style.fillColor
          else style.fillColor = patch.backgroundColor
        }
        if (patch.fillStyle !== undefined) style.fillStyle = patch.fillStyle
        if (patch.roundness !== undefined && hasCorners(o.kind)) style.roundness = patch.roundness
      }
      if (o.type === 'shape' && o.kind === 'counter') {
        if (patch.backgroundColor !== undefined) {
          if (patch.backgroundColor === 'transparent') delete style.fillColor
          else style.fillColor = patch.backgroundColor
        }
        if (patch.fontSize !== undefined) Object.assign(out, counterResize(o, patch.fontSize * COUNTER_SIZE_PER_FONT))
        if (patch.fontFamily !== undefined && patch.fontFamily !== (o.fontFamily ?? 'sans')) out.fontFamily = patch.fontFamily
        if (patch.counterStyle !== undefined && patch.counterStyle !== (o.counterStyle ?? 'pin')) out.counterStyle = patch.counterStyle
        if (!same(style, o.style)) (out as Record<string, unknown>).style = style
        return Object.keys(out).length ? out : undefined
      }
      if (isBlur && patch.blurSize !== undefined && patch.blurSize !== (o.blurSize ?? DEFAULT_BLUR_SIZE)) {
        (out as Record<string, unknown>).blurSize = patch.blurSize
        changed = true
      }
      if (isBlur && patch.blurMode !== undefined && patch.blurMode !== (o.blurMode ?? 'pixelate')) {
        (out as Record<string, unknown>).blurMode = patch.blurMode
        changed = true
      }
      if (patch.fontSize !== undefined && !isBlur && patch.fontSize !== (o.labelSize ?? DEFAULT_LABEL_SIZE)) {
        (out as Record<string, unknown>).labelSize = patch.fontSize
        changed = true
      }
      if (!same(style, o.style)) { (out as Record<string, unknown>).style = style; changed = true }
      if (o.type === 'arrow') {
        const a = o as ArrowObject
        if (patch.startHead !== undefined && patch.startHead !== a.startHead) { (out as Record<string, unknown>).startHead = patch.startHead; changed = true }
        if (patch.endHead !== undefined && patch.endHead !== a.endHead) { (out as Record<string, unknown>).endHead = patch.endHead; changed = true }
        if (patch.arrowType !== undefined && patch.arrowType !== (a.arrowType ?? 'straight')) {
          (out as Record<string, unknown>).arrowType = patch.arrowType
          // waypoints never carry over between routing kinds
          if (a.waypoints?.length) out.$unset = ['waypoints']
          changed = true
        }
      }
      return changed ? out : undefined
    }
    case 'text': {
      const out: Record<string, unknown> = {}
      if (patch.strokeColor !== undefined && patch.strokeColor !== o.color) out.color = patch.strokeColor
      if (patch.fontFamily !== undefined && patch.fontFamily !== o.fontFamily) out.fontFamily = patch.fontFamily
      if (patch.fontSize !== undefined && patch.fontSize !== o.fontSize) out.fontSize = patch.fontSize
      if (patch.textAlign !== undefined && patch.textAlign !== (o.align ?? 'left')) out.align = patch.textAlign
      if (patch.opacity !== undefined && patch.opacity !== (o.opacity ?? 1)) out.opacity = patch.opacity
      // only notes have a box; 'transparent' turns a note back into plain text
      if (o.background && patch.backgroundColor !== undefined && patch.backgroundColor !== o.background) {
        if (patch.backgroundColor === 'transparent') out.$unset = ['background', 'tail']
        else out.background = patch.backgroundColor
      }
      return Object.keys(out).length ? (out as ObjectPatch) : undefined
    }
    default: return undefined
  }
}

/** Counter resized to `size` about its centre; its pointer keeps its direction. */
function counterResize(o: ShapeObject, size: number): ObjectPatch | undefined {
  if (Math.abs(size - o.width) < 1e-6 && Math.abs(size - o.height) < 1e-6) return undefined
  const { transform: t } = o
  const cos = Math.cos(t.rotation), sin = Math.sin(t.rotation)
  // keep the centre: shift the origin by the rotated half-size difference
  const dx = (o.width - size) / 2, dy = (o.height - size) / 2
  const patch: ObjectPatch = {
    width: size, height: size,
    transform: { ...t, x: t.x + dx * cos - dy * sin, y: t.y + dx * sin + dy * cos },
  }
  if (o.tail) patch.tail = { x: (o.tail.x / o.width) * size, y: (o.tail.y / o.height) * size }
  return patch
}

function same(a: object, b: object): boolean {
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = new Set([...Object.keys(x), ...Object.keys(y)])
  for (const k of keys) if (x[k] !== y[k]) return false
  return true
}

/** ToolOptionsMap entries for shape / arrow / text derived from the shared item style. */
export function derivedToolOptions(item: ItemStyle, shapeKind: ToolOptionsMap['shape']['kind']): Pick<ToolOptionsMap, 'shape' | 'arrow' | 'text'> {
  const fillColor = item.backgroundColor === 'transparent' ? undefined : item.backgroundColor
  return {
    shape: {
      kind: shapeKind, strokeColor: item.strokeColor, strokeWidth: item.strokeWidth, fillColor, opacity: item.opacity,
      roughness: item.roughness, fillStyle: item.fillStyle, strokeStyle: item.strokeStyle, roundness: item.roundness,
    },
    arrow: {
      strokeColor: item.strokeColor, strokeWidth: item.strokeWidth, opacity: item.opacity, roughness: item.roughness,
      startHead: item.startHead, endHead: item.endHead, strokeStyle: item.strokeStyle, arrowType: item.arrowType,
    },
    text: {
      fontSize: item.fontSize, fontFamily: item.fontFamily, color: item.strokeColor, align: item.textAlign, opacity: item.opacity,
    },
  }
}

/** Translate a legacy per-tool options patch into an ItemStyle patch. */
export function itemPatchFromToolOptions(tool: 'shape' | 'arrow' | 'text', patch: Record<string, unknown>): StylePatch {
  const out: Record<string, unknown> = {}
  const map: Record<string, string> = tool === 'text'
    ? { fontSize: 'fontSize', fontFamily: 'fontFamily', color: 'strokeColor', align: 'textAlign', opacity: 'opacity' }
    : {
        strokeColor: 'strokeColor', strokeWidth: 'strokeWidth', opacity: 'opacity', roughness: 'roughness',
        fillStyle: 'fillStyle', strokeStyle: 'strokeStyle', startHead: 'startHead', endHead: 'endHead', arrowType: 'arrowType',
        roundness: 'roundness',
      }
  for (const [k, v] of Object.entries(patch)) {
    if (k in map && v !== undefined) out[map[k]] = v
  }
  if (tool === 'shape' && 'fillColor' in patch) out.backgroundColor = patch.fillColor || 'transparent'
  return out as StylePatch
}
