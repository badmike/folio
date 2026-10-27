import { DEFAULT_LABEL_SIZE, estimateTextSize, worldBounds, boundsUnion, type ArrowObject, type Operation, type ShapeKind } from '@folio/document'
import { mutate, notebookOf, pageOf, tool, type Executor } from './kit'
import { DIRECTIONS, LAYOUTS, layoutGraph } from './layout'
import { ARROWHEADS, makeArrow, makeShape, resolverWith, shapeStyle, shapeStyleInput, zAbove } from './objects'
import { roundRect } from './outline'
import { freeSpot } from './place'
import { ToolError, arr, obj, oneOf, opt, point, str, where } from './validate'

const NODE_SHAPES = ['rectangle', 'ellipse', 'diamond', 'triangle'] as const satisfies readonly ShapeKind[]
/** How much bigger than its label a node must be for the label to sit inside the outline. */
const INSET: Record<(typeof NODE_SHAPES)[number], number> = { rectangle: 1, ellipse: 1.4, diamond: 1.8, triangle: 1.8 }
const WRAP = 24
/** How far each arrow of a two-way pair bows out at least, so the two don't overlap. */
const PAIR_BEND = 36

/** Curve an arrow through a point beside its midpoint, on its left. Opposite arrows bow apart. */
export function bend(a: ArrowObject, by: number): ArrowObject {
  const dx = a.end.x - a.start.x, dy = a.end.y - a.start.y
  const len = Math.hypot(dx, dy) || 1
  const mid = { x: (a.start.x + a.end.x) / 2 + (dy / len) * by, y: (a.start.y + a.end.y) / 2 - (dx / len) * by }
  return { ...a, arrowType: 'curved', waypoints: [mid] }
}

/** Greedy word wrap, so labels are measured as they render. */
export function wrapLabel(label: string, max = WRAP): string {
  const lines: string[] = []
  for (const para of label.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > max) {
        lines.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    lines.push(line)
  }
  return lines.join('\n')
}

const nodeInput = obj({
  key: str({ min: 1, max: 64 }),
  label: str({ max: 200 }),
  shape: opt(oneOf(NODE_SHAPES)),
  style: opt(shapeStyleInput),
})
const edgeInput = obj({
  from: str({ min: 1, max: 64 }),
  to: str({ min: 1, max: 64 }),
  label: opt(str({ max: 100 })),
  endHead: opt(oneOf(ARROWHEADS)),
  style: opt(shapeStyleInput),
})

export const draw_diagram: Executor = tool(
  obj({
    ...where,
    nodes: arr(nodeInput, { min: 1, max: 200 }),
    edges: arr(edgeInput, { max: 400 }),
    layout: oneOf(LAYOUTS),
    direction: opt(oneOf(DIRECTIONS)),
    origin: opt(point),
  }),
  async (input, ctx) => {
    const keys = new Set<string>()
    input.nodes.forEach((n, i) => {
      if (keys.has(n.key)) throw new ToolError(`nodes[${i}].key: duplicate key ${JSON.stringify(n.key)}`)
      keys.add(n.key)
    })
    input.edges.forEach((e, i) => {
      for (const end of [e.from, e.to]) {
        if (!keys.has(end)) throw new ToolError(`edges[${i}]: unknown node key ${JSON.stringify(end)}; use keys from nodes`)
      }
    })

    const sized = input.nodes.map((n) => {
      const label = wrapLabel(n.label)
      const text = estimateTextSize({ text: label || ' ', fontSize: DEFAULT_LABEL_SIZE })
      const k = INSET[n.shape ?? 'rectangle']
      return { ...n, label, width: Math.ceil(Math.max(140, (text.width + 40) * k)), height: Math.ceil(Math.max(64, (text.height + 28) * k)) }
    })
    // labelled edges need room between layers for their label
    // (the renderer wraps arrow labels at ARROW_LABEL_WIDTH = 160)
    const longest = Math.max(0, ...input.edges.map((e) => e.label?.length ?? 0)) * DEFAULT_LABEL_SIZE * 0.55
    const labelRoom = !longest ? 0
      : input.direction === 'right' ? Math.min(160, longest) + 16
      : Math.ceil(longest / 160) * DEFAULT_LABEL_SIZE * 1.3 + 16
    const pos = layoutGraph(input.layout, sized, input.edges, input.direction, { rank: 80 + labelRoom, node: 48 })
    const width = Math.max(...sized.map((n) => pos.get(n.key)!.x + n.width))
    const height = Math.max(...sized.map((n) => pos.get(n.key)!.y + n.height))

    const notebookId = notebookOf(ctx.host, input.notebookId)
    const { result, effects } = await mutate(ctx, notebookId, (doc) => {
      const { page, viewport } = pageOf(ctx.host, doc, input.pageId)
      const origin = input.origin ?? freeSpot(doc, page, viewport, width, height)
      const z = zAbove(doc, page.id)
      const now = Date.now()
      const shapes = sized.map((n) => {
        const p = pos.get(n.key)!
        return makeShape(
          { kind: n.shape ?? 'rectangle', x: origin.x + p.x, y: origin.y + p.y, width: n.width, height: n.height, label: n.label, style: shapeStyle(n.style) },
          { z: z(), now },
        )
      })
      const byKey = new Map(sized.map((n, i) => [n.key, shapes[i]]))
      const resolve = resolverWith(doc, page.id, shapes)
      const pairs = new Set(input.edges.map((e) => `${e.from}\n${e.to}`))
      const arrows = input.edges.map((e) => {
        const a = makeArrow(byKey.get(e.from)!, byKey.get(e.to)!, { label: e.label, endHead: e.endHead, style: shapeStyle(e.style) }, resolve, { z: z(), now })
        if (e.from === e.to || !pairs.has(`${e.to}\n${e.from}`)) return a
        // side by side (vertical arrows) the labels need half their width each
        const label = e.label ? estimateTextSize({ text: e.label, fontSize: DEFAULT_LABEL_SIZE }).width / 2 + 12 : 0
        return bend(a, Math.max(PAIR_BEND, label))
      })
      const all = [...shapes, ...arrows]
      const ops: Operation[] = [{ type: 'addObjects', pageId: page.id, objects: all }]
      const bounds = boundsUnion(all.map((o) => worldBounds(o, resolve)))
      return {
        ops, pageId: page.id, ids: all.map((o) => o.id), bounds,
        nodes: Object.fromEntries(sized.map((n) => [n.key, byKey.get(n.key)!.id])),
        arrows: arrows.map((a) => a.id),
      }
    })
    return { output: { nodes: result.nodes, arrows: result.arrows, bounds: result.bounds && roundRect(result.bounds) }, effects }
  },
)
