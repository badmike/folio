import {
  DEFAULT_LABEL_SIZE, boundsUnion, createId, estimateTextSize, resolveArrowEndpoints, worldBounds,
  type CanvasObject, type GroupObject, type ImageObject, type NotebookDocumentApi, type ObjectId, type ObjectPatch,
  type Operation, type PageId, type Rect, type ShapeObject, type TextObject,
} from '@folio/document'
import { patchForObject, type StylePatch } from '@folio/editor'
import type { ToolEffect } from '../protocol'
import { mutate, notebookOf, pageOf, tool, type Executor, type ToolOutcome } from './kit'
import { parseMarkdown, type MdBlock } from './markdown'
import {
  ARROWHEADS, ARROW_TYPES, FONT_FAMILIES, SEMANTIC_TYPES, SHAPE_KINDS,
  expandIds, makeArrow, makeShape, makeText, objectOn, resolverWith, shapeStyle, shapeStyleInput, styleFields, withDescendants, zAbove,
} from './objects'
import { roundRect } from './outline'
import { freeSpot } from './place'
import { ToolError, arr, coord, hex, id, num, obj, oneOf, opt, size, str, where } from './validate'

const GAP = 24

/** Both coordinates or neither; anything else is a call the model should fix. */
function position(x: number | undefined, y: number | undefined, path: string): { x: number; y: number } | null {
  if (x === undefined && y === undefined) return null
  if (x === undefined || y === undefined) throw new ToolError(`${path}: give both x and y, or neither for automatic placement`)
  return { x, y }
}

const boundsOf = (doc: NotebookDocumentApi, pageId: PageId, objs: CanvasObject[]): Rect | undefined =>
  boundsUnion(objs.map((o) => worldBounds(o, resolverWith(doc, pageId, objs))))

/** Shared tail of the creating tools: the ids and where everything landed. */
const created = (ids: ObjectId[], bounds: Rect | undefined, effects: ToolEffect[]): ToolOutcome => ({
  output: { ids, bounds: bounds && roundRect(bounds) },
  effects,
})

// ---------------------------------------------------------------------------
// create_shapes
// ---------------------------------------------------------------------------

const shapeInput = obj({
  kind: oneOf(SHAPE_KINDS),
  x: opt(coord),
  y: opt(coord),
  width: size,
  height: size,
  label: opt(str({ max: 500 })),
  labelSize: opt(num({ min: 8, max: 200 })),
  style: opt(shapeStyleInput),
})

export const create_shapes: Executor = tool(obj({ ...where, shapes: arr(shapeInput, { min: 1, max: 100 }) }), async (input, ctx) => {
  const notebookId = notebookOf(ctx.host, input.notebookId)
  const { result, effects } = await mutate(ctx, notebookId, (doc) => {
    const { page, viewport } = pageOf(ctx.host, doc, input.pageId)
    const fixed = input.shapes.map((s, i) => position(s.x, s.y, `shapes[${i}]`))
    // shapes without a position go in one row in free space
    const loose = input.shapes.filter((_, i) => !fixed[i])
    const rowWidth = loose.reduce((w, s) => w + s.width, 0) + GAP * Math.max(0, loose.length - 1)
    const row = loose.length ? freeSpot(doc, page, viewport, rowWidth, Math.max(...loose.map((s) => s.height))) : { x: 0, y: 0 }
    const z = zAbove(doc, page.id)
    const now = Date.now()
    const shapes = input.shapes.map((s, i) => {
      const at = fixed[i] ?? { x: row.x, y: row.y }
      if (!fixed[i]) row.x += s.width + GAP
      return makeShape({ ...s, ...at, style: shapeStyle(s.style) }, { z: z(), now })
    })
    const ids = shapes.map((s) => s.id)
    return { ops: [{ type: 'addObjects', pageId: page.id, objects: shapes }] satisfies Operation[], pageId: page.id, ids, bounds: boundsOf(doc, page.id, shapes) }
  })
  return created(result.ids, result.bounds, effects)
})

// ---------------------------------------------------------------------------
// create_text
// ---------------------------------------------------------------------------

function textFor(b: MdBlock, body: number): Pick<TextObject, 'text' | 'fontSize' | 'semanticType'> & Partial<Pick<TextObject, 'fontFamily'>> {
  switch (b.kind) {
    case 'heading': return { text: b.text, fontSize: Math.round(body * [1.8, 1.4, 1.2][b.level - 1]), semanticType: 'heading' }
    case 'paragraph': return { text: b.text, fontSize: body, semanticType: 'paragraph' }
    case 'list': return { text: b.text, fontSize: body, semanticType: 'list-item' }
    case 'equation': return { text: b.text, fontSize: body, semanticType: 'equation' }
    case 'code': return { text: b.text, fontSize: Math.round(body * 0.85), semanticType: 'paragraph', fontFamily: 'mono' }
  }
}

export const create_text: Executor = tool(
  obj({
    ...where,
    markdown: str({ min: 1, max: 20000 }),
    x: opt(coord),
    y: opt(coord),
    width: opt(num({ min: 60, max: 4000 })),
    fontSize: opt(num({ min: 8, max: 120 })),
    color: opt(hex),
    note: opt(hex),
  }),
  async (input, ctx) => {
    const notebookId = notebookOf(ctx.host, input.notebookId)
    const width = input.width ?? 480
    const body = input.fontSize ?? DEFAULT_LABEL_SIZE
    const blocks = parseMarkdown(input.markdown)
    if (!blocks.length) throw new ToolError('markdown: nothing to write')
    // a note is one object: a coloured box with all the text
    const parts = input.note
      ? [{ text: blocks.map((b) => b.text).join('\n\n'), fontSize: body, semanticType: 'paragraph' as const }]
      : blocks.map((b) => textFor(b, body))
    const heights = parts.map((p) => estimateTextSize({ text: p.text, fontSize: p.fontSize, width }).height)
    const total = heights.reduce((s, h) => s + h, 0) + body * 0.8 * (parts.length - 1)

    const { result, effects } = await mutate(ctx, notebookId, (doc) => {
      const { page, viewport } = pageOf(ctx.host, doc, input.pageId)
      const at = position(input.x, input.y, 'input') ?? freeSpot(doc, page, viewport, width, total)
      const z = zAbove(doc, page.id)
      const now = Date.now()
      let y = at.y
      const texts = parts.map((p, i) => {
        const t = makeText({ ...p, x: at.x, y, width, color: input.color, background: input.note }, { z: z(), now })
        y += heights[i] + body * 0.8
        return t
      })
      const ids = texts.map((t) => t.id)
      return { ops: [{ type: 'addObjects', pageId: page.id, objects: texts }] satisfies Operation[], pageId: page.id, ids, bounds: boundsOf(doc, page.id, texts) }
    })
    return created(result.ids, result.bounds, effects)
  },
)

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

const arrowFields = {
  label: opt(str({ max: 200 })),
  arrowType: opt(oneOf(ARROW_TYPES)),
  startHead: opt(oneOf(ARROWHEADS)),
  endHead: opt(oneOf(ARROWHEADS)),
  style: opt(shapeStyleInput),
}

/** A live, bindable object (arrows cannot be arrow targets). */
function endpoint(doc: NotebookDocumentApi, pageId: PageId, oid: ObjectId): CanvasObject {
  const o = objectOn(doc, pageId, oid)
  if (o.type === 'arrow') throw new ToolError(`${oid} is an arrow; connect shapes, text, images or groups`)
  return o
}

export const connect: Executor = tool(
  obj({ ...where, connections: arr(obj({ from: id, to: id, ...arrowFields }), { min: 1, max: 100 }) }),
  async (input, ctx) => {
    const notebookId = notebookOf(ctx.host, input.notebookId)
    const { result, effects } = await mutate(ctx, notebookId, (doc) => {
      const { page } = pageOf(ctx.host, doc, input.pageId)
      const resolve = resolverWith(doc, page.id)
      const z = zAbove(doc, page.id)
      const now = Date.now()
      const arrows = input.connections.map((c, i) => {
        if (c.from === c.to) throw new ToolError(`connections[${i}]: from and to are the same object`)
        const from = endpoint(doc, page.id, c.from)
        const to = endpoint(doc, page.id, c.to)
        return makeArrow(from, to, { ...c, style: shapeStyle(c.style) }, resolve, { z: z(), now })
      })
      const ids = arrows.map((a) => a.id)
      return { ops: [{ type: 'addObjects', pageId: page.id, objects: arrows }] satisfies Operation[], pageId: page.id, ids, bounds: boundsOf(doc, page.id, arrows) }
    })
    return created(result.ids, result.bounds, effects)
  },
)

// ---------------------------------------------------------------------------
// update_objects
// ---------------------------------------------------------------------------

const updateInput = obj({
  id,
  text: opt(str({ max: 20000 })),
  semanticType: opt(oneOf(SEMANTIC_TYPES)),
  width: opt(size),
  height: opt(size),
  style: opt(obj({
    ...styleFields,
    fontSize: opt(num({ min: 8, max: 200 })),
    fontFamily: opt(oneOf(FONT_FAMILIES)),
    align: opt(oneOf(['left', 'center', 'right'])),
    arrowType: arrowFields.arrowType,
    startHead: arrowFields.startHead,
    endHead: arrowFields.endHead,
  })),
})
type UpdateInput = ReturnType<typeof updateInput>

/** The patch for one object, or undefined when nothing changes. Ink only takes style. */
function patchFor(o: CanvasObject, u: UpdateInput, path: string): ObjectPatch | undefined {
  const patch: ObjectPatch = {}
  const unset: string[] = []
  if (o.type === 'ink' && (u.text !== undefined || u.semanticType || u.width || u.height)) {
    throw new ToolError(`${path}: ${u.id} is handwriting or a drawing; ink can only be restyled, moved or deleted`)
  }
  if (u.text !== undefined) {
    if (o.type === 'text') {
      if (!u.text) throw new ToolError(`${path}.text: must not be empty; use delete_objects to remove text`)
      patch.text = u.text
    } else if (o.type === 'shape' || o.type === 'arrow') {
      if (u.text) patch.label = u.text
      else unset.push('label')
    } else throw new ToolError(`${path}.text: ${o.type} objects have no text`)
  }
  if (u.semanticType) {
    if (o.type !== 'text') throw new ToolError(`${path}.semanticType: only text objects have a semantic type`)
    patch.semanticType = u.semanticType
  }
  if (u.width || u.height) {
    if (o.type === 'shape' || o.type === 'image') {
      patch.width = u.width ?? o.width
      patch.height = u.height ?? o.height
    } else if (o.type === 'text' && !u.height) patch.width = u.width
    else throw new ToolError(`${path}: ${o.type === 'text' ? 'text takes only a wrap width' : `${o.type} objects have no size`}`)
  }
  if (u.style) {
    const { fillColor, align, ...rest } = u.style
    const sp: StylePatch = { ...rest, backgroundColor: fillColor, textAlign: align }
    const p = patchForObject(o, sp)
    if (p) {
      const { $unset, ...fields } = p
      Object.assign(patch, fields)
      unset.push(...($unset ?? []))
    }
  }
  if (unset.length) patch.$unset = unset
  return Object.keys(patch).length ? patch : undefined
}

export const update_objects: Executor = tool(obj({ ...where, updates: arr(updateInput, { min: 1, max: 200 }) }), async (input, ctx) => {
  const notebookId = notebookOf(ctx.host, input.notebookId)
  const { result, effects } = await mutate(ctx, notebookId, (doc) => {
    const { page } = pageOf(ctx.host, doc, input.pageId)
    const targets = expandIds(doc, page.id, input.updates.map((u) => u.id))
    const now = Date.now()
    const patches: { id: ObjectId; patch: ObjectPatch }[] = []
    const unchanged: ObjectId[] = []
    input.updates.forEach((u, i) => {
      for (const oid of targets[i]) {
        const patch = patchFor(objectOn(doc, page.id, oid), u, `updates[${i}]`)
        if (patch) patches.push({ id: oid, patch: { ...patch, updatedAt: now } })
        else unchanged.push(oid)
      }
    })
    const ids = patches.map((p) => p.id)
    const ops: Operation[] = patches.length ? [{ type: 'updateObjects', pageId: page.id, patches }] : []
    return { ops, pageId: page.id, ids, unchanged }
  })
  return { output: { updated: result.ids, unchanged: result.unchanged.length ? result.unchanged : undefined }, effects }
})

// ---------------------------------------------------------------------------
// move_objects
// ---------------------------------------------------------------------------

const moveInput = obj({ id, x: opt(coord), y: opt(coord), dx: opt(coord), dy: opt(coord) })

/** The object, its group members and, for frames, the frame's content. */
function moveSet(doc: NotebookDocumentApi, pageId: PageId, ids: ObjectId[]): CanvasObject[] {
  const all = withDescendants(doc, pageId, ids)
  const frames = new Set(all.filter((oid) => {
    const o = doc.object(pageId, oid)
    return o?.type === 'shape' && o.kind === 'frame'
  }))
  const content = frames.size ? doc.objects(pageId).filter((o) => o.frameId && frames.has(o.frameId)).map((o) => o.id) : []
  return withDescendants(doc, pageId, [...all, ...content]).map((oid) => objectOn(doc, pageId, oid))
}

function shifted(o: CanvasObject, dx: number, dy: number): ObjectPatch | undefined {
  if (o.type === 'group') return undefined // a group's bounds are its members'
  if (o.type !== 'arrow') return { transform: { ...o.transform, x: o.transform.x + dx, y: o.transform.y + dy } }
  const move = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy })
  return { start: move(o.start), end: move(o.end), ...(o.waypoints ? { waypoints: o.waypoints.map(move) } : {}) }
}

export const move_objects: Executor = tool(obj({ ...where, moves: arr(moveInput, { min: 1, max: 200 }) }), async (input, ctx) => {
  const notebookId = notebookOf(ctx.host, input.notebookId)
  const { result, effects } = await mutate(ctx, notebookId, (doc) => {
    const { page } = pageOf(ctx.host, doc, input.pageId)
    const targets = expandIds(doc, page.id, input.moves.map((m) => m.id))
    const resolve = resolverWith(doc, page.id)
    const now = Date.now()
    const patches = new Map<ObjectId, ObjectPatch>()
    input.moves.forEach((m, i) => {
      const to = position(m.x, m.y, `moves[${i}]`)
      if (to && (m.dx !== undefined || m.dy !== undefined)) throw new ToolError(`moves[${i}]: use either x and y or dx and dy`)
      if (!to && m.dx === undefined && m.dy === undefined) throw new ToolError(`moves[${i}]: give x and y (new top-left) or dx and dy`)
      const members = moveSet(doc, page.id, targets[i])
      const b = boundsUnion(members.filter((o) => o.type !== 'group').map((o) => worldBounds(o, resolve)))
      if (!b) return
      const dx = to ? to.x - b.x : (m.dx ?? 0)
      const dy = to ? to.y - b.y : (m.dy ?? 0)
      for (const o of members) {
        const p = !patches.has(o.id) && shifted(o, dx, dy)
        if (p) patches.set(o.id, { ...p, updatedAt: now })
      }
    })
    const ids = [...patches.keys()]
    const ops: Operation[] = ids.length ? [{ type: 'updateObjects', pageId: page.id, patches: ids.map((oid) => ({ id: oid, patch: patches.get(oid)! })) }] : []
    return { ops, pageId: page.id, ids }
  })
  return { output: { moved: result.ids }, effects }
})

// ---------------------------------------------------------------------------
// delete_objects
// ---------------------------------------------------------------------------

/**
 * Like the editor: groups go with their members, frames with their content, and arrows or note
 * pointers bound to deleted objects keep pointing where they were.
 */
export const delete_objects: Executor = tool(obj({ ...where, ids: arr(id, { min: 1, max: 500 }) }), async (input, ctx) => {
  const notebookId = notebookOf(ctx.host, input.notebookId)
  const { result, effects } = await mutate(ctx, notebookId, (doc) => {
    const { page } = pageOf(ctx.host, doc, input.pageId)
    const picked = new Set(withDescendants(doc, page.id, expandIds(doc, page.id, input.ids).flat()))
    const objs = doc.objects(page.id)
    const del = new Set(withDescendants(doc, page.id, [...picked, ...objs.filter((o) => o.frameId && picked.has(o.frameId)).map((o) => o.id)]))
    const resolve = resolverWith(doc, page.id)
    const now = Date.now()
    const patches: { id: ObjectId; patch: ObjectPatch }[] = []
    for (const o of objs) {
      if (del.has(o.id)) continue
      if (o.type === 'arrow') {
        const sb = !!o.startBinding && del.has(o.startBinding.objectId)
        const eb = !!o.endBinding && del.has(o.endBinding.objectId)
        if (!sb && !eb) continue
        const r = resolveArrowEndpoints(o, resolve)
        patches.push({ id: o.id, patch: {
          ...(sb ? { start: r.start } : {}), ...(eb ? { end: r.end } : {}), updatedAt: now,
          $unset: [...(sb ? ['startBinding'] : []), ...(eb ? ['endBinding'] : [])],
        } })
      } else if (o.type === 'text' && o.tailBinding && del.has(o.tailBinding.objectId)) {
        patches.push({ id: o.id, patch: { updatedAt: now, $unset: ['tailBinding'] } })
      }
    }
    const ids = [...del]
    const ops: Operation[] = [
      ...(patches.length ? [{ type: 'updateObjects' as const, pageId: page.id, patches }] : []),
      { type: 'deleteObjects', pageId: page.id, ids },
    ]
    return { ops, ids }
  })
  return { output: { deleted: result.ids }, effects }
})

// ---------------------------------------------------------------------------
// group_objects
// ---------------------------------------------------------------------------

const FRAME_STYLE: ShapeObject['style'] = { strokeColor: '#9aa0a8', strokeWidth: 1, opacity: 1, roughness: 0, seed: 1 }

function topGroupOf(doc: NotebookDocumentApi, pageId: PageId, oid: ObjectId): ObjectId {
  let cur = oid
  for (let depth = 0; depth < 32; depth++) {
    const parent = doc.object(pageId, cur)?.groupId
    if (!parent || !doc.object(pageId, parent)) break
    cur = parent
  }
  return cur
}

export const group_objects: Executor = tool(
  obj({
    ...where,
    ids: arr(id, { min: 1, max: 500 }),
    as: oneOf(['group', 'frame']),
    title: opt(str({ max: 200 })),
    padding: opt(num({ min: 0, max: 400 })),
  }),
  async (input, ctx) => {
    const notebookId = notebookOf(ctx.host, input.notebookId)
    const { result, effects } = await mutate(ctx, notebookId, (doc) => {
      const { page } = pageOf(ctx.host, doc, input.pageId)
      const picked = [...new Set(expandIds(doc, page.id, input.ids).flat())]
      const now = Date.now()

      if (input.as === 'group') {
        const members = [...new Set(picked.map((oid) => topGroupOf(doc, page.id, oid)))].map((oid) => objectOn(doc, page.id, oid))
        if (members.length < 2) throw new ToolError('a group needs at least two objects that are not already in one group')
        const group: GroupObject = {
          id: createId(), type: 'group', transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          z: Math.max(...members.map((m) => m.z)), createdAt: now, updatedAt: now, childIds: members.map((m) => m.id),
        }
        const ops: Operation[] = [
          { type: 'addObjects', pageId: page.id, objects: [group] },
          { type: 'updateObjects', pageId: page.id, patches: members.map((m) => ({ id: m.id, patch: { groupId: group.id, updatedAt: now } })) },
        ]
        return { ops, pageId: page.id, ids: [group.id], id: group.id }
      }

      const leaves = withDescendants(doc, page.id, picked).map((oid) => objectOn(doc, page.id, oid)).filter((o) => o.type !== 'group')
      if (leaves.some((o) => o.type === 'shape' && o.kind === 'frame')) throw new ToolError('frames cannot contain other frames')
      const b = boundsOf(doc, page.id, leaves)!
      const pad = input.padding ?? 32
      const frame = makeShape({
        kind: 'frame', x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad,
        label: input.title, style: FRAME_STYLE,
      }, { z: Math.min(...leaves.map((o) => o.z)) - 1, now })
      const ops: Operation[] = [
        { type: 'addObjects', pageId: page.id, objects: [frame] },
        { type: 'updateObjects', pageId: page.id, patches: leaves.map((o) => ({ id: o.id, patch: { frameId: frame.id, updatedAt: now } })) },
      ]
      return { ops, pageId: page.id, ids: [frame.id], id: frame.id }
    })
    return { output: { id: result.id }, effects }
  },
)

// ---------------------------------------------------------------------------
// insert_image
// ---------------------------------------------------------------------------

export const insert_image: Executor = tool(
  obj({ ...where, assetId: id, x: opt(coord), y: opt(coord), width: opt(num({ min: 16, max: 4000 })) }),
  async (input, ctx) => {
    const notebookId = notebookOf(ctx.host, input.notebookId)
    const meta = await ctx.host.asset(input.assetId)
    if (!meta) throw new ToolError(`assetId: unknown asset ${input.assetId}. Use an id from the user's attachments.`)
    const width = input.width ?? Math.min(meta.width, 480)
    const height = Math.max(1, Math.round((width * meta.height) / Math.max(1, meta.width)))
    const { result, effects } = await mutate(ctx, notebookId, (doc) => {
      const { page, viewport } = pageOf(ctx.host, doc, input.pageId)
      const at = position(input.x, input.y, 'input') ?? freeSpot(doc, page, viewport, width, height)
      const now = Date.now()
      const image: ImageObject = {
        id: createId(), type: 'image', transform: { x: at.x, y: at.y, rotation: 0, scaleX: 1, scaleY: 1 },
        z: zAbove(doc, page.id)(), createdAt: now, updatedAt: now, assetId: input.assetId, mimeType: meta.mimeType, width, height,
      }
      return { ops: [{ type: 'addObjects', pageId: page.id, objects: [image] }] satisfies Operation[], pageId: page.id, ids: [image.id], bounds: boundsOf(doc, page.id, [image]) }
    })
    return created(result.ids, result.bounds, effects)
  },
)
