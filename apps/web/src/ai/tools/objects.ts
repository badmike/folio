/** Building blocks for AI-made objects: styles, factories, z order and id resolution. */
import {
  DEFAULT_LABEL_SIZE, createId, defaultShapeStyle, identityTransform, rectCenter, resolveArrowEndpoints, worldBounds,
  type ArrowObject, type ArrowType, type Arrowhead, type CanvasObject, type FillStyle, type FontFamily,
  type NotebookDocumentApi, type ObjectId, type ObjectResolver, type PageId, type Roundness, type SemanticTextType,
  type ShapeKind, type ShapeObject, type ShapeStyle, type StrokeLineStyle, type TextObject,
} from '@folio/document'
import { ToolError, fill, hex, num, obj, oneOf, opt, type Infer } from './validate'

export const SHAPE_KINDS = ['rectangle', 'ellipse', 'diamond', 'triangle', 'line'] as const satisfies readonly ShapeKind[]
export const FILL_STYLES = ['hachure', 'cross-hatch', 'solid'] as const satisfies readonly FillStyle[]
export const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const satisfies readonly StrokeLineStyle[]
export const ROUNDNESS = ['sharp', 'round'] as const satisfies readonly Roundness[]
export const ARROW_TYPES = ['straight', 'curved', 'elbow'] as const satisfies readonly ArrowType[]
export const ARROWHEADS = [
  'none', 'arrow', 'triangle', 'triangle-outline', 'dot', 'dot-outline', 'bar',
  'diamond', 'diamond-outline', 'crowfoot-one', 'crowfoot-many', 'crowfoot-one-or-many',
] as const satisfies readonly Arrowhead[]
export const SEMANTIC_TYPES = ['heading', 'paragraph', 'list-item', 'label', 'equation'] as const satisfies readonly SemanticTextType[]
export const FONT_FAMILIES = [
  'hand', 'sans', 'mono', 'caveat', 'kalam', 'patrick', 'indie', 'architect', 'shadows', 'gloria', 'marker', 'playpen', 'gochi',
] as const satisfies readonly FontFamily[]

/** The theme's handwritten font: 'hand' renders in whatever font the notebook's theme picks. */
export const AI_FONT: FontFamily = 'hand'
export const INK_COLOR = '#1e1e1e'

export const styleFields = {
  strokeColor: opt(hex),
  fillColor: opt(fill),
  fillStyle: opt(oneOf(FILL_STYLES)),
  strokeStyle: opt(oneOf(STROKE_STYLES)),
  strokeWidth: opt(num({ min: 0.5, max: 16 })),
  roughness: opt(num({ min: 0, max: 3 })),
  opacity: opt(num({ min: 0.05, max: 1 })),
  roundness: opt(oneOf(ROUNDNESS)),
}
export const shapeStyleInput = obj(styleFields)
export type StyleInput = Infer<typeof shapeStyleInput>

export function shapeStyle(s: StyleInput = {}): ShapeStyle {
  const base = defaultShapeStyle(Math.floor(Math.random() * 2 ** 31))
  return {
    ...base,
    strokeColor: s.strokeColor ?? base.strokeColor,
    strokeWidth: s.strokeWidth ?? base.strokeWidth,
    opacity: s.opacity ?? base.opacity,
    roughness: s.roughness ?? base.roughness,
    fillColor: s.fillColor && s.fillColor !== 'transparent' ? s.fillColor : undefined,
    fillStyle: s.fillStyle,
    strokeStyle: s.strokeStyle,
    roundness: s.roundness,
  }
}

/** Next z values above everything on the page. */
export function zAbove(doc: NotebookDocumentApi, pageId: PageId): () => number {
  let z = doc.objects(pageId).reduce((m, o) => Math.max(m, o.z), 0)
  return () => ++z
}

/** Objects of a page plus not-yet-applied ones, for bounds of new arrows. */
export function resolverWith(doc: NotebookDocumentApi, pageId: PageId, extra: CanvasObject[] = []): ObjectResolver {
  const added = new Map(extra.map((o) => [o.id, o]))
  return (id) => added.get(id) ?? doc.object(pageId, id)
}

interface Stamp { z: number; now: number }

export function makeShape(
  s: { kind: ShapeKind; x: number; y: number; width: number; height: number; label?: string; labelSize?: number; style: ShapeStyle },
  { z, now }: Stamp,
): ShapeObject {
  return {
    id: createId(), type: 'shape', kind: s.kind, transform: { ...identityTransform(), x: s.x, y: s.y },
    z, createdAt: now, updatedAt: now, width: s.width, height: s.height, style: s.style,
    label: s.label || undefined, labelSize: s.labelSize,
  }
}

export function makeText(
  t: { text: string; x: number; y: number; fontSize: number; width?: number; color?: string; fontFamily?: FontFamily; semanticType?: SemanticTextType; background?: string },
  { z, now }: Stamp,
): TextObject {
  return {
    id: createId(), type: 'text', transform: { ...identityTransform(), x: t.x, y: t.y }, z, createdAt: now, updatedAt: now,
    text: t.text, fontSize: t.fontSize, fontFamily: t.fontFamily ?? AI_FONT, color: t.color ?? INK_COLOR,
    width: t.width, semanticType: t.semanticType, background: t.background,
  }
}

export interface ArrowOptions {
  label?: string
  arrowType?: ArrowType
  startHead?: Arrowhead
  endHead?: Arrowhead
  style: ShapeStyle
}

/** An arrow bound to both objects; its stored endpoints are where it meets their edges. */
export function makeArrow(from: CanvasObject, to: CanvasObject, o: ArrowOptions, resolve: ObjectResolver, { z, now }: Stamp): ArrowObject {
  const arrow: ArrowObject = {
    id: createId(), type: 'arrow', transform: identityTransform(), z, createdAt: now, updatedAt: now,
    start: rectCenter(worldBounds(from, resolve)), end: rectCenter(worldBounds(to, resolve)),
    startBinding: { objectId: from.id }, endBinding: { objectId: to.id },
    style: o.style, startHead: o.startHead ?? 'none', endHead: o.endHead ?? 'arrow',
    arrowType: o.arrowType, label: o.label || undefined, labelSize: o.label ? DEFAULT_LABEL_SIZE : undefined,
  }
  return { ...arrow, ...resolveArrowEndpoints(arrow, resolve) }
}

/** Live (not superseded) object or a ToolError naming the id. */
export function objectOn(doc: NotebookDocumentApi, pageId: PageId, id: ObjectId): CanvasObject {
  const o = doc.object(pageId, id)
  if (!o || o.supersededBy) throw new ToolError(`object ${id} not found on page ${pageId}. Use ids from get_page.`)
  return o
}

/**
 * Object ids from the model, with recognition ids (handwriting lines of the outline) expanded to
 * their strokes. Throws listing every unknown id.
 */
export function expandIds(doc: NotebookDocumentApi, pageId: PageId, ids: ObjectId[]): ObjectId[][] {
  const recs = new Map(doc.recognitions(pageId).map((r) => [r.id, r]))
  const missing: string[] = []
  const out = ids.map((id) => {
    const o = doc.object(pageId, id)
    if (o && !o.supersededBy) return [id]
    const rec = recs.get(id)
    const strokes = rec?.strokeIds.filter((s) => doc.object(pageId, s)) ?? []
    if (!strokes.length) missing.push(id)
    return strokes
  })
  if (missing.length) throw new ToolError(`unknown ids on page ${pageId}: ${missing.join(', ')}. Use ids from get_page.`)
  return out
}

/** The ids plus every member of groups among them (recursively). */
export function withDescendants(doc: NotebookDocumentApi, pageId: PageId, ids: Iterable<ObjectId>): ObjectId[] {
  const out = new Set<ObjectId>()
  const visit = (id: ObjectId, depth: number) => {
    const o = doc.object(pageId, id)
    if (!o || out.has(id) || depth > 32) return
    out.add(id)
    if (o.type === 'group') o.childIds.forEach((c) => visit(c, depth + 1))
  }
  for (const id of ids) visit(id, 0)
  return [...out]
}
