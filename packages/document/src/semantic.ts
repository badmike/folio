import type { NotebookDocumentApi } from './api'
import {
  boundsUnion, distanceToRect, rectCenter, rectContains, resolveArrowEndpoints, worldBounds,
} from './geometry'
import type {
  ArrowObject, CanvasObject, Page, Rect, Recognition, SemanticTextType, ShapeObject, TextObject,
} from './types'

// ---------------------------------------------------------------------------
// Public analysis model (shared by markdown export and the AI summary)
// ---------------------------------------------------------------------------

export type SemanticBlock =
  | { kind: 'heading'; level: 1 | 2; text: string; bounds: Rect }
  | { kind: 'paragraph'; text: string; bounds: Rect }
  | { kind: 'list'; items: string[]; bounds: Rect }
  | { kind: 'equation'; text: string; bounds: Rect }
  | { kind: 'image'; assetId: string; bounds: Rect }
  | { kind: 'placeholder'; bounds: Rect }

export interface Relation {
  from: string
  to: string
  /** '→' | '↔' | '—' */
  connector: '→' | '↔' | '—'
  label?: string
}

export interface PageAnalysis {
  page: Page
  blocks: SemanticBlock[]
  relations: Relation[]
}

interface Item {
  kind: 'text' | 'image' | 'drawing'
  text: string
  bounds: Rect
  /** Line height metric in world units (undefined = unknown, never a heading by size). */
  size?: number
  semantic?: SemanticTextType
  assetId?: string
  /** Multi-line or block-like: never merged into a line with neighbours. */
  own?: boolean
}

interface Node {
  id: string
  bounds: Rect
  label?: string
  fallback: string
  isShape: boolean
}

/** Shapes that take part in diagrams (frames and blur masks are containers / effects, lines are drawings). */
function isDiagramNode(s: ShapeObject): boolean {
  return s.kind !== 'line' && s.kind !== 'frame' && s.kind !== 'blur'
}

export function analyzeNotebook(doc: NotebookDocumentApi): PageAnalysis[] {
  const collected = doc.pages().map((page) => ({ page, ...collectPage(doc, page) }))
  // Body text size = character-weighted median of all sized text items.
  const sized: { size: number; w: number }[] = []
  for (const c of collected) {
    for (const it of c.items) if (it.kind === 'text' && it.size) sized.push({ size: it.size, w: Math.max(1, it.text.length) })
  }
  const body = weightedMedian(sized)
  return collected.map((c) => ({
    page: c.page,
    blocks: layoutItems(c.items, body),
    relations: c.relations,
  }))
}

// ---------------------------------------------------------------------------
// Collection: turn objects + recognitions into positioned items and relations
// ---------------------------------------------------------------------------

function collectPage(doc: NotebookDocumentApi, page: Page): { items: Item[]; relations: Relation[] } {
  const objs = doc.objects(page.id)
  const byId = new Map<string, CanvasObject>(objs.map((o) => [o.id, o]))
  const resolve = (id: string) => byId.get(id)
  const live = objs.filter((o) => !o.supersededBy)

  // Recognitions whose strokes are still the visible representation.
  const recs = activeRecognitions(doc, page.id)
  const recognizedStrokes = new Set<string>()
  for (const r of recs) for (const s of r.strokeIds) recognizedStrokes.add(s)

  const textItems: Item[] = []
  const textNodes = new Map<string, Item>() // text object id -> item (arrow targets)
  for (const o of live) {
    if (o.type !== 'text') continue
    const t = o as TextObject
    if (!t.text.trim()) continue
    const lines = t.text.split('\n').length
    const bounds = worldBounds(o, resolve)
    const item: Item = {
      kind: 'text', text: t.text, bounds, semantic: t.semanticType,
      size: t.fontSize * Math.abs(t.transform.scaleY), own: lines > 1,
    }
    textItems.push(item)
    textNodes.set(o.id, item)
  }
  for (const r of recs) {
    if (r.kind !== 'text') continue
    const text = (r.refinedText ?? r.text ?? '').trim()
    if (!text) continue
    const lines = text.split('\n').length
    textItems.push({
      kind: 'text', text, bounds: r.bounds, semantic: r.semanticType,
      size: r.bounds.height / lines, own: lines > 1,
    })
  }

  // --- diagram nodes -------------------------------------------------------
  const nodes: Node[] = []
  for (const o of live) {
    if (o.type === 'shape' && isDiagramNode(o as ShapeObject)) {
      nodes.push({ id: o.id, bounds: worldBounds(o, resolve), label: (o as ShapeObject).label?.trim() || undefined, fallback: `[${(o as ShapeObject).kind}]`, isShape: true })
    } else if (o.type === 'image') {
      nodes.push({ id: o.id, bounds: worldBounds(o, resolve), label: undefined, fallback: '[image]', isShape: false })
    } else if (o.type === 'text' && textNodes.has(o.id)) {
      const it = textNodes.get(o.id)!
      nodes.push({ id: o.id, bounds: it.bounds, label: it.text.replace(/\s+/g, ' ').trim(), fallback: '[text]', isShape: false })
    }
  }
  for (const r of recs) {
    if (r.kind === 'shape' && r.shape && r.shape !== 'arrow') {
      nodes.push({ id: r.id, bounds: r.bounds, label: undefined, fallback: `[${r.shape}]`, isShape: true })
    }
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const attach = (binding: { objectId: string } | undefined, p: { x: number; y: number }): Node | undefined => {
    if (binding) {
      const n = nodeById.get(binding.objectId)
      if (n) return n
    }
    let best: Node | undefined
    let bestD = Infinity
    let bestArea = Infinity
    for (const n of nodes) {
      const d = distanceToRect(p, n.bounds)
      if (d > 40) continue
      const area = n.bounds.width * n.bounds.height
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && area < bestArea)) {
        best = n; bestD = d; bestArea = area
      }
    }
    return best
  }

  interface Link { arrow: ArrowObject; a: Node; b: Node }
  const links: Link[] = []
  const looseArrowLabels: Item[] = []
  for (const o of live) {
    if (o.type !== 'arrow') continue
    const arrow = o as ArrowObject
    const { start, end } = resolveArrowEndpoints(arrow, resolve)
    const a = attach(arrow.startBinding, start)
    const b = attach(arrow.endBinding, end)
    if (a && b && a !== b) links.push({ arrow, a, b })
    else if (arrow.label?.trim()) {
      looseArrowLabels.push({ kind: 'text', text: arrow.label.trim(), bounds: worldBounds(arrow, resolve) })
    }
  }
  const connected = new Set<string>()
  for (const l of links) { connected.add(l.a.id); connected.add(l.b.id) }

  // Assign each text item to the smallest shape node containing its center.
  const shapeNodes = nodes.filter((n) => n.isShape)
  const consumed = new Set<Item>()
  const inside = new Map<string, Item[]>()
  for (const it of textItems) {
    const c = rectCenter(it.bounds)
    let best: Node | undefined
    for (const n of shapeNodes) {
      if (!rectContains(n.bounds, c)) continue
      if (!best || n.bounds.width * n.bounds.height < best.bounds.width * best.bounds.height) best = n
    }
    if (best) {
      const arr = inside.get(best.id) ?? []
      arr.push(it)
      inside.set(best.id, arr)
    }
  }
  for (const n of shapeNodes) {
    const its = inside.get(n.id)
    if (!n.label && its?.length) {
      its.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
      n.label = its.map((i) => i.text.replace(/\s+/g, ' ').trim()).join(' ')
      if (connected.has(n.id)) for (const i of its) consumed.add(i)
    }
  }

  const items: Item[] = textItems.filter((i) => !consumed.has(i))
  items.push(...looseArrowLabels)

  // Unconnected shapes: keep their label as text, or mark them as drawings.
  const drawingRects: Rect[] = []
  for (const n of shapeNodes) {
    if (connected.has(n.id)) continue
    const isRec = !byId.has(n.id)
    const shapeLabel = isRec ? undefined : (byId.get(n.id) as ShapeObject).label?.trim()
    if (shapeLabel) items.push({ kind: 'text', text: shapeLabel, bounds: n.bounds })
    else if (!inside.get(n.id)?.length) drawingRects.push(n.bounds)
  }
  for (const o of live) {
    if (o.type === 'shape' && (o as ShapeObject).kind === 'line') drawingRects.push(worldBounds(o, resolve))
    // a frame's name is a heading-like label for what it contains
    if (o.type === 'shape' && (o as ShapeObject).kind === 'frame' && (o as ShapeObject).label?.trim()) {
      const b = worldBounds(o, resolve)
      items.push({ kind: 'text', text: (o as ShapeObject).label!.trim(), bounds: { x: b.x, y: b.y - 1, width: b.width, height: 1 }, own: true })
    }
    if (o.type === 'image') {
      items.push({ kind: 'image', text: '', assetId: (o as { assetId: string }).assetId, bounds: worldBounds(o, resolve), own: true })
    }
  }
  // Ink that carries no recognition is an unlabeled drawing.
  for (const o of live) {
    if (o.type === 'ink' && !recognizedStrokes.has(o.id)) drawingRects.push(worldBounds(o, resolve))
  }
  for (const r of clusterRects(drawingRects, 24)) {
    if (Math.max(r.width, r.height) >= 16) items.push({ kind: 'drawing', text: '', bounds: r, own: true })
  }

  // --- relations -----------------------------------------------------------
  const label = (n: Node) => n.label || n.fallback
  const rels = links
    .map((l) => {
      const { arrow } = l
      const sh = arrow.startHead === 'arrow'
      const eh = arrow.endHead === 'arrow'
      let from = l.a, to = l.b
      let connector: Relation['connector'] = '—'
      if (sh && eh) connector = '↔'
      else if (eh) connector = '→'
      else if (sh) { connector = '→'; from = l.b; to = l.a }
      const rel: Relation = { from: label(from), to: label(to), connector }
      if (arrow.label?.trim()) rel.label = arrow.label.trim()
      return { rel, y: from.bounds.y, x: from.bounds.x }
    })
    .sort((p, q) => p.y - q.y || p.x - q.x)
  const seen = new Set<string>()
  const relations: Relation[] = []
  for (const { rel } of rels) {
    const k = JSON.stringify(rel)
    if (!seen.has(k)) { seen.add(k); relations.push(rel) }
  }
  return { items, relations }
}

function clusterRects(rects: Rect[], gap: number): Rect[] {
  const n = rects.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const order = rects.map((_, i) => i).sort((a, b) => rects[a].x - rects[b].x)
  for (let a = 0; a < n; a++) {
    const ra = rects[order[a]]
    for (let b = a + 1; b < n; b++) {
      const rb = rects[order[b]]
      if (rb.x - gap > ra.x + ra.width) break
      if (
        rb.x <= ra.x + ra.width + gap && ra.x <= rb.x + rb.width + gap &&
        rb.y <= ra.y + ra.height + gap && ra.y <= rb.y + rb.height + gap
      ) parent[find(order[a])] = find(order[b])
    }
  }
  const groups = new Map<number, Rect[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const g = groups.get(r) ?? []
    g.push(rects[i])
    groups.set(r, g)
  }
  return [...groups.values()].map((g) => boundsUnion(g)!)
}

function weightedMedian(xs: { size: number; w: number }[]): number | undefined {
  if (!xs.length) return undefined
  const sorted = [...xs].sort((a, b) => a.size - b.size)
  const total = sorted.reduce((s, x) => s + x.w, 0)
  let acc = 0
  for (const x of sorted) {
    acc += x.w
    if (acc >= total / 2) return x.size
  }
  return sorted[sorted.length - 1].size
}

// ---------------------------------------------------------------------------
// Layout: reading order (XY-cut), lines, blocks
// ---------------------------------------------------------------------------

function layoutItems(items: Item[], body: number | undefined): SemanticBlock[] {
  if (!items.length) return []
  const heights = items
    .filter((i) => i.kind === 'text')
    .map((i) => i.bounds.height / Math.max(1, i.text.split('\n').length))
    .sort((a, b) => a - b)
  const H = Math.max(8, heights.length ? heights[Math.floor(heights.length / 2)] : 16)

  const leaves = xyCut(items, H)
  const blocks: SemanticBlock[] = []
  for (const leaf of leaves) buildBlocks(leaf, H, body, blocks)
  return blocks
}

function xyCut(items: Item[], H: number): Item[][] {
  if (items.length <= 1) return [items]
  const col = findColumnCut(items, 2 * H)
  if (col) return [...xyCut(col[0], H), ...xyCut(col[1], H)]
  const row = findRowCut(items, 0.6 * H)
  if (row) return [...xyCut(row[0], H), ...xyCut(row[1], H)]
  return [items]
}

function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0)
}

function findColumnCut(items: Item[], minGap: number): [Item[], Item[]] | undefined {
  const s = [...items].sort((a, b) => a.bounds.x - b.bounds.x)
  let maxRight = s[0].bounds.x + s[0].bounds.width
  for (let i = 1; i < s.length; i++) {
    if (s[i].bounds.x - maxRight >= minGap) {
      const left = s.slice(0, i), right = s.slice(i)
      const lb = boundsUnion(left.map((l) => l.bounds))!, rb = boundsUnion(right.map((r) => r.bounds))!
      const ov = overlap1d(lb.y, lb.y + lb.height, rb.y, rb.y + rb.height)
      // Only a real column split when both sides share a substantial vertical span.
      if (ov >= 0.3 * Math.min(lb.height, rb.height)) return [left, right]
    }
    maxRight = Math.max(maxRight, s[i].bounds.x + s[i].bounds.width)
  }
  return undefined
}

function findRowCut(items: Item[], minGap: number): [Item[], Item[]] | undefined {
  const s = [...items].sort((a, b) => a.bounds.y - b.bounds.y)
  let maxBottom = s[0].bounds.y + s[0].bounds.height
  for (let i = 1; i < s.length; i++) {
    if (s[i].bounds.y - maxBottom >= minGap) return [s.slice(0, i), s.slice(i)]
    maxBottom = Math.max(maxBottom, s[i].bounds.y + s[i].bounds.height)
  }
  return undefined
}

interface Entry {
  kind: 'text' | 'image' | 'drawing'
  text: string
  semantic?: SemanticTextType
  size?: number
  top: number
  bottom: number
  left: number
  bounds: Rect
  assetId?: string
}

const BULLET = /^\s*([-*•–·])\s+(.*)$/s
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/s

function buildBlocks(leaf: Item[], H: number, body: number | undefined, out: SemanticBlock[]): void {
  // 1. group into lines by vertical overlap
  const sorted = [...leaf].sort((a, b) => a.bounds.y + a.bounds.height / 2 - (b.bounds.y + b.bounds.height / 2))
  const lines: Item[][] = []
  let cur: Item[] = []
  let cTop = 0, cBottom = 0
  const flush = () => { if (cur.length) lines.push(cur); cur = [] }
  for (const it of sorted) {
    const b = it.bounds
    if (it.own || (cur.length && cur.some((c) => c.own))) {
      flush()
      cur = [it]; cTop = b.y; cBottom = b.y + b.height
      flush()
      continue
    }
    if (cur.length) {
      const ov = overlap1d(cTop, cBottom, b.y, b.y + b.height)
      if (ov >= 0.5 * Math.min(cBottom - cTop, b.height)) {
        cur.push(it); cTop = Math.min(cTop, b.y); cBottom = Math.max(cBottom, b.y + b.height)
        continue
      }
      flush()
    }
    cur = [it]; cTop = b.y; cBottom = b.y + b.height
  }
  flush()

  // 2. lines -> entries
  const entries: Entry[] = []
  for (const line of lines) {
    line.sort((a, b) => a.bounds.x - b.bounds.x)
    const first = line[0]
    if (first.kind !== 'text') {
      entries.push({
        kind: first.kind, text: '', assetId: first.assetId, bounds: first.bounds,
        top: first.bounds.y, bottom: first.bounds.y + first.bounds.height, left: first.bounds.x,
      })
      continue
    }
    if (line.length === 1 && first.text.includes('\n')) {
      const parts = first.text.split('\n').filter((p) => p.trim())
      const lh = first.bounds.height / Math.max(1, first.text.split('\n').length)
      parts.forEach((p, i) => entries.push({
        kind: 'text', text: p.trim(), semantic: first.semantic, size: first.size,
        top: first.bounds.y + i * lh, bottom: first.bounds.y + (i + 1) * lh, left: first.bounds.x,
        bounds: { ...first.bounds, y: first.bounds.y + i * lh, height: lh },
      }))
      continue
    }
    const sem = line.every((l) => l.semantic === first.semantic) ? first.semantic : undefined
    const sizes = line.map((l) => l.size).filter((s): s is number => !!s)
    const u = boundsUnion(line.map((l) => l.bounds))!
    entries.push({
      kind: 'text', text: line.map((l) => l.text.replace(/\s+/g, ' ').trim()).join(' '),
      semantic: sem, size: sizes.length ? Math.max(...sizes) : undefined,
      top: u.y, bottom: u.y + u.height, left: u.x, bounds: u,
    })
  }

  // 3. entries -> blocks
  let list: { items: string[]; bounds: Rect; baseLeft: number } | null = null
  let para: { text: string; bounds: Rect; bottom: number } | null = null
  const endPara = () => { if (para) out.push({ kind: 'paragraph', text: para.text, bounds: para.bounds }); para = null }
  const endList = () => { if (list) out.push({ kind: 'list', items: list.items, bounds: list.bounds }); list = null }

  for (const e of entries) {
    if (e.kind === 'image') { endPara(); endList(); out.push({ kind: 'image', assetId: e.assetId!, bounds: e.bounds }); continue }
    if (e.kind === 'drawing') { endPara(); endList(); out.push({ kind: 'placeholder', bounds: e.bounds }); continue }

    const ratio = body && e.size ? e.size / body : 1
    if (e.semantic === 'equation') {
      endPara(); endList()
      out.push({ kind: 'equation', text: e.text, bounds: e.bounds })
      continue
    }
    if (e.semantic === 'heading' || (!e.semantic && ratio >= 1.6)) {
      endPara(); endList()
      const level: 1 | 2 = e.semantic === 'heading' ? (ratio >= 1.6 ? 1 : 2) : ratio >= 2.2 ? 1 : 2
      out.push({ kind: 'heading', level, text: e.text, bounds: e.bounds })
      continue
    }
    const bullet = BULLET.exec(e.text)
    const numbered = NUMBERED.exec(e.text)
    if (e.semantic === 'list-item' || bullet || numbered) {
      endPara()
      const body = bullet ? bullet[2] : numbered ? `${numbered[1]}. ${numbered[2]}` : e.text
      const text = bullet || e.semantic === 'list-item' && !numbered ? `- ${body}` : body
      if (!list) list = { items: [], bounds: e.bounds, baseLeft: e.left }
      else list.bounds = boundsUnion([list.bounds, e.bounds])!
      const indent = Math.max(0, Math.min(3, Math.round((e.left - list.baseLeft) / (2 * H))))
      list.items.push('  '.repeat(indent) + text)
      continue
    }
    endList()
    if (para && e.top - para.bottom < 0.8 * H) {
      para.text += ' ' + e.text
      para.bounds = boundsUnion([para.bounds, e.bounds])!
      para.bottom = e.bottom
    } else {
      endPara()
      para = { text: e.text, bounds: e.bounds, bottom: e.bottom }
    }
  }
  endPara()
  endList()
}

// ---------------------------------------------------------------------------
// Recognition helper shared with search
// ---------------------------------------------------------------------------

/** Recognitions that still describe visible (non-superseded) ink. */
export function activeRecognitions(doc: NotebookDocumentApi, pageId: string): Recognition[] {
  const byId = new Map(doc.objects(pageId).map((o) => [o.id, o]))
  return doc.recognitions(pageId).filter((r) => {
    const existing = r.strokeIds.map((s) => byId.get(s)).filter((s): s is CanvasObject => !!s)
    return existing.length > 0 && existing.every((s) => !s.supersededBy)
  })
}
