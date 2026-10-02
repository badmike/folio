import { createId, identityTransform } from './factories'
import { boundsUnion, encodeInkPoints, worldBounds } from './geometry'
import {
  type ArrowObject,
  type Arrowhead,
  type CanvasObject,
  type FillStyle,
  type FontFamily,
  type GroupObject,
  type ObjectId,
  type Rect,
  type ShapeObject,
  type ShapeStyle,
  type StrokeLineStyle,
  type TextObject,
  type Transform,
  type Vec2,
} from './types'

export interface ExcalidrawAsset {
  id: string
  mimeType: string
  dataUrl: string
}

export interface ExcalidrawImport {
  objects: CanvasObject[]
  assets: ExcalidrawAsset[]
  /** World bounds of the imported content (undefined when empty). */
  bounds?: Rect
}

/** True when the string looks like Excalidraw JSON (cheap check used before parsing clipboard text). */
export function isExcalidrawJson(text: string): boolean {
  return /^\s*\{/.test(text) && /"type"\s*:\s*"excalidraw(?:\/clipboard)?"/.test(text)
}

// ---------------------------------------------------------------------------
// Reading the untrusted input
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

/** The fields of an Excalidraw element we use, with defaults filled in. */
interface ExElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle: number
  strokeColor: string
  backgroundColor: string
  fillStyle: string
  strokeWidth: number
  strokeStyle: string
  roughness: number
  opacity: number
  seed: number
  /** Innermost group first. */
  groupIds: string[]
  frameId?: string
  containerId?: string
  rounded: boolean
  points: Vec2[]
  pressures: number[]
  simulatePressure: boolean
  startBinding?: string
  endBinding?: string
  startArrowhead: string | null
  endArrowhead: string | null
  elbowed: boolean
  fontSize: number
  fontFamily: number
  text: string
  textAlign: string
  autoResize: boolean
  fileId?: string
  name?: string
}

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const num = (v: unknown, fallback: number): number => (isNumber(v) ? v : fallback)
const str = (v: unknown, fallback: string): string => (isString(v) ? v : fallback)
const optStr = (v: unknown): string | undefined => (isString(v) && v !== '' ? v : undefined)
const bindingId = (v: unknown): string | undefined => (isRecord(v) ? optStr(v.elementId) : undefined)

function readPoints(v: unknown): Vec2[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((p) => (Array.isArray(p) && isNumber(p[0]) && isNumber(p[1]) ? [{ x: p[0], y: p[1] }] : []))
}

function readElement(raw: unknown): ExElement | undefined {
  if (!isRecord(raw) || !isString(raw.id) || !isString(raw.type) || raw.isDeleted === true) return undefined
  return {
    id: raw.id,
    type: raw.type,
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    width: num(raw.width, 0),
    height: num(raw.height, 0),
    angle: num(raw.angle, 0),
    strokeColor: str(raw.strokeColor, '#1e1e1e'),
    backgroundColor: str(raw.backgroundColor, 'transparent'),
    fillStyle: str(raw.fillStyle, 'solid'),
    strokeWidth: num(raw.strokeWidth, 2),
    strokeStyle: str(raw.strokeStyle, 'solid'),
    roughness: num(raw.roughness, 1),
    opacity: num(raw.opacity, 100),
    seed: num(raw.seed, 1),
    groupIds: Array.isArray(raw.groupIds) ? raw.groupIds.filter(isString) : [],
    frameId: optStr(raw.frameId),
    containerId: optStr(raw.containerId),
    rounded: isRecord(raw.roundness),
    points: readPoints(raw.points),
    pressures: Array.isArray(raw.pressures) ? raw.pressures.filter(isNumber) : [],
    simulatePressure: raw.simulatePressure === true,
    startBinding: bindingId(raw.startBinding),
    endBinding: bindingId(raw.endBinding),
    startArrowhead: isString(raw.startArrowhead) ? raw.startArrowhead : null,
    // Very old files have no arrowhead fields and drew an end arrowhead by default.
    endArrowhead: raw.endArrowhead === undefined ? 'arrow' : isString(raw.endArrowhead) ? raw.endArrowhead : null,
    elbowed: raw.elbowed === true,
    fontSize: num(raw.fontSize, 20),
    fontFamily: num(raw.fontFamily, 1),
    text: isString(raw.originalText) ? raw.originalText : str(raw.text, ''),
    textAlign: str(raw.textAlign, 'left'),
    autoResize: raw.autoResize !== false,
    fileId: optStr(raw.fileId),
    name: isString(raw.name) ? raw.name : undefined,
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/**
 * Excalidraw rotates about the element centre, we rotate about the local origin.
 * Returns the transform that puts the local origin (unrotated world position `origin`)
 * where Excalidraw would draw it after rotating by `angle` about `centre`.
 */
function rotatedTransform(origin: Vec2, centre: Vec2, angle: number): Transform {
  if (angle === 0) return { ...identityTransform(), x: origin.x, y: origin.y }
  return { ...rotateAbout(origin, centre, angle), rotation: angle, scaleX: 1, scaleY: 1 }
}

function rotateAbout(p: Vec2, c: Vec2, angle: number): Vec2 {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

function boxTransform(el: ExElement): Transform {
  const centre = { x: el.x + el.width / 2, y: el.y + el.height / 2 }
  return rotatedTransform({ x: el.x, y: el.y }, centre, el.angle)
}

function pointsBox(points: Vec2[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of points) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Element points, or the box diagonal for linear elements saved without points. */
function linePoints(el: ExElement): Vec2[] {
  return el.points.length >= 2 ? el.points : [{ x: 0, y: 0 }, { x: el.width, y: el.height }]
}

const FILL_STYLES: Record<string, FillStyle> = { hachure: 'hachure', zigzag: 'hachure', 'cross-hatch': 'cross-hatch', solid: 'solid' }
const STROKE_STYLES: Record<string, StrokeLineStyle> = { solid: 'solid', dashed: 'dashed', dotted: 'dotted' }

function shapeStyle(el: ExElement): ShapeStyle {
  const style: ShapeStyle = {
    strokeColor: el.strokeColor,
    strokeWidth: el.strokeWidth,
    fillStyle: FILL_STYLES[el.fillStyle] ?? 'hachure',
    strokeStyle: STROKE_STYLES[el.strokeStyle] ?? 'solid',
    opacity: el.opacity / 100,
    roughness: Math.min(2, Math.max(0, el.roughness)),
    seed: el.seed,
  }
  if (el.backgroundColor !== 'transparent') style.fillColor = el.backgroundColor
  if (el.rounded) style.roundness = 'round'
  return style
}

function arrowhead(head: string | null): Arrowhead {
  switch (head) {
    case null: return 'none'
    case 'bar': return 'bar'
    case 'dot':
    case 'circle': return 'dot'
    case 'circle_outline': return 'dot-outline'
    case 'triangle': return 'triangle'
    case 'triangle_outline': return 'triangle-outline'
    case 'diamond': return 'diamond'
    case 'diamond_outline': return 'diamond-outline'
    case 'crowfoot_one': return 'crowfoot-one'
    case 'crowfoot_many': return 'crowfoot-many'
    case 'crowfoot_one_or_many': return 'crowfoot-one-or-many'
    default: return 'arrow'
  }
}

/** Excalidraw font ids: 1 Virgil, 2 Helvetica, 3 Cascadia, 5 Excalifont, 6 Nunito, 7 Lilita One, 8 Comic Shanns. */
const FONT_FAMILIES: Record<number, FontFamily> = { 1: 'hand', 2: 'sans', 3: 'mono', 5: 'hand', 6: 'sans', 7: 'sans', 8: 'mono' }

const INK_WIDTHS: Record<number, number> = { 1: 1.5, 2: 2.5, 4: 4.5 }

const SHAPE_KINDS = new Set(['rectangle', 'ellipse', 'diamond'])
/** Element types that can carry a bound text label. */
const CONTAINER_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'line', 'arrow'])

/** Drops interior points that lie on the straight segment between their neighbours. */
function cornersOnly(points: Vec2[]): Vec2[] {
  const out: Vec2[] = []
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) > 1e-6) out.push(b)
  }
  return out
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Accepts a parsed `.excalidraw` file ({type:'excalidraw', version, elements, files}) or an
 * Excalidraw clipboard payload ({type:'excalidraw/clipboard', elements, files}). Throws an
 * Error with a plain message when `input` is neither.
 */
export function importExcalidraw(input: unknown, opts: { now?: number } = {}): ExcalidrawImport {
  if (
    !isRecord(input) ||
    (input.type !== 'excalidraw' && input.type !== 'excalidraw/clipboard') ||
    !Array.isArray(input.elements)
  ) {
    throw new Error('This is not an Excalidraw file or clipboard payload.')
  }
  const files = isRecord(input.files) ? input.files : {}
  const now = opts.now ?? Date.now()
  const elements = input.elements.flatMap((raw) => readElement(raw) ?? [])
  const containerIds = new Set(elements.filter((el) => CONTAINER_TYPES.has(el.type)).map((el) => el.id))

  const objects: CanvasObject[] = []
  const assets: ExcalidrawAsset[] = []
  const assetByFile = new Map<string, ExcalidrawAsset>()
  /** Excalidraw element id -> imported object. */
  const byOldId = new Map<string, CanvasObject>()
  /** Imported object -> its source element, for resolving references afterwards. */
  const sources = new Map<CanvasObject, ExElement>()
  const labels: ExElement[] = []
  let z = 0

  const base = () => ({ id: createId(), z: ++z, createdAt: now, updatedAt: now })

  const convert = (el: ExElement): CanvasObject | undefined => {
    if (SHAPE_KINDS.has(el.type)) {
      return {
        ...base(), type: 'shape', kind: el.type === 'ellipse' ? 'ellipse' : el.type === 'diamond' ? 'diamond' : 'rectangle',
        transform: boxTransform(el), width: el.width, height: el.height, style: shapeStyle(el),
      }
    }
    switch (el.type) {
      case 'line': {
        const pts = linePoints(el)
        const box = pointsBox(pts)
        const local = pts.map((p) => ({ x: p.x - box.x, y: p.y - box.y }))
        const origin = { x: el.x + box.x, y: el.y + box.y }
        const centre = { x: origin.x + box.width / 2, y: origin.y + box.height / 2 }
        const shape: ShapeObject = {
          ...base(), type: 'shape', kind: 'line', transform: rotatedTransform(origin, centre, el.angle),
          width: box.width, height: box.height, style: shapeStyle(el),
        }
        const last = local[local.length - 1]
        const isDiagonal = local.length === 2 && local[0].x === 0 && local[0].y === 0 && last.x === box.width && last.y === box.height
        if (!isDiagonal) shape.points = local
        return shape
      }
      case 'arrow': {
        const pts = linePoints(el)
        const box = pointsBox(pts)
        const centre = { x: el.x + box.x + box.width / 2, y: el.y + box.y + box.height / 2 }
        const world = pts.map((p) => rotateAbout({ x: el.x + p.x, y: el.y + p.y }, centre, el.angle))
        const arrow: ArrowObject = {
          ...base(), type: 'arrow', transform: identityTransform(),
          start: world[0], end: world[world.length - 1], style: shapeStyle(el),
          startHead: arrowhead(el.startArrowhead), endHead: arrowhead(el.endArrowhead),
        }
        if (el.elbowed) {
          arrow.arrowType = 'elbow'
          const corners = cornersOnly(world)
          if (corners.length) arrow.waypoints = corners
        } else if (world.length > 2) {
          arrow.arrowType = 'curved'
          arrow.waypoints = world.slice(1, -1)
        }
        return arrow
      }
      case 'text': {
        const text: TextObject = {
          ...base(), type: 'text', transform: boxTransform(el), text: el.text, fontSize: el.fontSize,
          fontFamily: FONT_FAMILIES[el.fontFamily] ?? 'hand', color: el.strokeColor, opacity: el.opacity / 100,
        }
        if (el.textAlign === 'left' || el.textAlign === 'center' || el.textAlign === 'right') text.align = el.textAlign
        if (!el.autoResize) text.width = el.width
        return text
      }
      case 'freedraw': {
        const box = el.points.length ? pointsBox(el.points) : { x: 0, y: 0, width: el.width, height: el.height }
        const centre = { x: el.x + box.x + box.width / 2, y: el.y + box.y + box.height / 2 }
        const points = encodeInkPoints(
          el.points.map((p, i) => ({ x: p.x, y: p.y, pressure: el.pressures[i] ?? 0.5, tiltX: 0, tiltY: 0, t: i * 8 })),
        )
        return {
          ...base(), type: 'ink', transform: rotatedTransform({ x: el.x, y: el.y }, centre, el.angle), points,
          style: {
            tool: 'pen', color: el.strokeColor, width: INK_WIDTHS[el.strokeWidth] ?? el.strokeWidth,
            opacity: el.opacity / 100, pressureSensitive: !el.simulatePressure && el.pressures.length > 0,
          },
          startedAt: now, pointerType: 'pen',
        }
      }
      case 'image': {
        const file = el.fileId ? files[el.fileId] : undefined
        if (!el.fileId || !isRecord(file) || !isString(file.dataURL)) return undefined
        let asset = assetByFile.get(el.fileId)
        if (!asset) {
          asset = { id: createId(), mimeType: str(file.mimeType, 'application/octet-stream'), dataUrl: file.dataURL }
          assetByFile.set(el.fileId, asset)
          assets.push(asset)
        }
        return {
          ...base(), type: 'image', transform: boxTransform(el), assetId: asset.id, mimeType: asset.mimeType,
          width: el.width, height: el.height,
        }
      }
      case 'frame':
      case 'magicframe':
        return {
          ...base(), type: 'shape', kind: 'frame', transform: boxTransform(el), width: el.width, height: el.height,
          label: el.name ?? 'Frame', style: { strokeColor: '#bbb', strokeWidth: 1, opacity: 1, roughness: 0, seed: 1 },
        }
      default:
        return undefined
    }
  }

  for (const el of elements) {
    if (el.type === 'text' && el.containerId && containerIds.has(el.containerId)) {
      labels.push(el)
      continue
    }
    const obj = convert(el)
    if (!obj) continue
    objects.push(obj)
    byOldId.set(el.id, obj)
    sources.set(obj, el)
  }

  // References can point forward in the element list, so resolve them once everything exists.
  for (const label of labels) {
    const target = byOldId.get(label.containerId ?? '')
    if (target?.type === 'shape' || target?.type === 'arrow') {
      target.label = label.text
      target.labelSize = label.fontSize
    }
  }

  const bindable = (oldId: string | undefined): ObjectId | undefined => {
    const target = oldId ? byOldId.get(oldId) : undefined
    return target && (target.type === 'shape' || target.type === 'text' || target.type === 'image') ? target.id : undefined
  }

  const groups = new Map<string, GroupObject>()
  const groupFor = (oldId: string): GroupObject => {
    let group = groups.get(oldId)
    if (!group) {
      group = { id: createId(), type: 'group', transform: identityTransform(), z: 0, createdAt: now, updatedAt: now, childIds: [] }
      groups.set(oldId, group)
    }
    return group
  }

  for (const [obj, el] of sources) {
    if (obj.type === 'arrow') {
      const start = bindable(el.startBinding)
      const end = bindable(el.endBinding)
      if (start) obj.startBinding = { objectId: start }
      if (end) obj.endBinding = { objectId: end }
    }
    const frame = el.frameId ? byOldId.get(el.frameId) : undefined
    if (frame?.type === 'shape' && frame.kind === 'frame') obj.frameId = frame.id

    let child: CanvasObject = obj
    for (const gid of el.groupIds) {
      const group = groupFor(gid)
      group.z = Math.max(group.z, obj.z)
      if (!group.childIds.includes(child.id)) group.childIds.push(child.id)
      child.groupId = group.id
      child = group
    }
  }
  objects.push(...groups.values())

  const byId = new Map(objects.map((o) => [o.id, o]))
  const resolve = (id: ObjectId) => byId.get(id)
  const bounds = boundsUnion(objects.flatMap((o) => (o.type === 'group' ? [] : [worldBounds(o, resolve)])))
  return { objects, assets, bounds }
}
