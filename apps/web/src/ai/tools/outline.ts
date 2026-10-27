/**
 * The semantic outline the model reads: one compact line per object with its id, type, short text
 * and rounded world bounds. Recognized ink shows as its text under the recognition id (tools accept
 * that id for the strokes); other ink is clustered into drawings. Text is JSON-quoted, so notebook
 * content can never break the line structure (the server fences it as untrusted data).
 */
import {
  activeRecognitions, boundsUnion, worldBounds,
  type CanvasObject, type NotebookDocumentApi, type ObjectId, type Page, type PageId, type Rect,
} from '@folio/document'

export const OUTLINE_MAX_CHARS = 12_000

export interface Entry {
  id: string
  /** Object ids the line stands for (strokes for handwriting and drawings). */
  members: ObjectId[]
  bounds: Rect
  line: string
}

export const fmtRect = (b: Rect) =>
  `[${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}]`

export const roundRect = (b: Rect): Rect => ({
  x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height),
})

/** Single-line, length-capped, JSON-quoted text. */
export function quote(text: string, max = 80): string {
  const flat = text.replace(/\s*\n\s*/g, ' / ').replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat)
}

/** Resolver over a page's objects, for bounds of arrows and groups. */
export function resolverFor(doc: NotebookDocumentApi, pageId: PageId) {
  return (id: ObjectId) => doc.object(pageId, id)
}

function objectLine(o: CanvasObject, b: Rect): string {
  const where = `${fmtRect(b)}${o.frameId ? ` in ${o.frameId}` : ''}${o.groupId ? ` group ${o.groupId}` : ''}`
  switch (o.type) {
    case 'text': {
      const kind = o.background ? 'note' : `text${o.semanticType ? `:${o.semanticType}` : ''}`
      return `${o.id} ${kind} ${quote(o.text)} ${where}`
    }
    case 'shape':
      return `${o.id} ${o.kind}${o.label?.trim() ? ` ${quote(o.label)}` : ''} ${where}`
    case 'arrow': {
      const ends = `${o.startBinding?.objectId ?? '·'}→${o.endBinding?.objectId ?? '·'}`
      return `${o.id} arrow ${ends}${o.label?.trim() ? ` ${quote(o.label)}` : ''} ${where}`
    }
    case 'image':
      return `${o.id} image ${where}`
    case 'group':
      return `${o.id} group (${o.childIds.length} objects) ${where}`
    case 'ink':
      return `${o.id} ink ${where}`
  }
}

/** Outline entries of a page, or of the given objects only. */
export function pageEntries(doc: NotebookDocumentApi, pageId: PageId, only?: Set<ObjectId>): Entry[] {
  const resolve = resolverFor(doc, pageId)
  const live = doc.objects(pageId).filter((o) => !o.supersededBy && (!only || only.has(o.id)))
  const out: Entry[] = []

  const recognized = new Set<ObjectId>()
  for (const r of activeRecognitions(doc, pageId)) {
    if (only && !r.strokeIds.some((s) => only.has(s))) continue
    r.strokeIds.forEach((s) => recognized.add(s))
    const n = `(${r.strokeIds.length} stroke${r.strokeIds.length === 1 ? '' : 's'})`
    const text = r.kind === 'text' ? `handwriting ${quote(r.refinedText ?? r.text ?? '')}` : `drawn-${r.shape ?? 'shape'}`
    out.push({ id: r.id, members: r.strokeIds, bounds: r.bounds, line: `${r.id} ${text} ${fmtRect(r.bounds)} ${n}` })
  }

  const loose: { id: ObjectId; bounds: Rect }[] = []
  for (const o of live) {
    if (o.type === 'ink') {
      if (!recognized.has(o.id)) loose.push({ id: o.id, bounds: worldBounds(o, resolve) })
      continue
    }
    const b = worldBounds(o, resolve)
    out.push({ id: o.id, members: [o.id], bounds: b, line: objectLine(o, b) })
  }

  for (const c of clusters(loose, 24)) {
    const ids = c.map((s) => s.id)
    const b = boundsUnion(c.map((s) => s.bounds))!
    const listed = ids.length > 12 ? `${ids.slice(0, 12).join(',')},…+${ids.length - 12}` : ids.join(',')
    out.push({ id: ids[0], members: ids, bounds: b, line: `${ids[0]} drawing ${fmtRect(b)} (unrecognized ink, strokes ${listed})` })
  }
  return out
}

/** Gap between two rects (0 when they touch or overlap). */
function gap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width))
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height))
  return Math.hypot(dx, dy)
}

/** Proximity clusters (union-find over rects closer than `within`). */
function clusters<T extends { bounds: Rect }>(items: T[], within: number): T[][] {
  const parent = items.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const order = items.map((_, i) => i).sort((a, b) => items[a].bounds.x - items[b].bounds.x)
  for (let a = 0; a < order.length; a++) {
    const ra = items[order[a]].bounds
    for (let b = a + 1; b < order.length; b++) {
      const rb = items[order[b]].bounds
      if (rb.x - within > ra.x + ra.width) break
      if (gap(ra, rb) <= within) parent[find(order[a])] = find(order[b])
    }
  }
  const groups = new Map<number, T[]>()
  items.forEach((it, i) => {
    const root = find(i)
    const group = groups.get(root)
    if (group) group.push(it)
    else groups.set(root, [it])
  })
  return [...groups.values()]
}

/** Lines in order (nearest to `near` first, then reading order), capped at `max` characters. */
export function renderEntries(entries: Entry[], near: Rect | null, max: number): string {
  const sorted = entries
    .map((e) => ({ e, d: near ? gap(e.bounds, near) : 0 }))
    .sort((a, b) => a.d - b.d || a.e.bounds.y - b.e.bounds.y || a.e.bounds.x - b.e.bounds.x)
  const lines: string[] = []
  let used = 0
  for (const [i, { e }] of sorted.entries()) {
    if (used + e.line.length + 1 > max) {
      lines.push(`… ${sorted.length - i} more objects not shown (use read_objects or look for detail)`)
      break
    }
    lines.push(e.line)
    used += e.line.length + 1
  }
  return lines.join('\n')
}

export function pageHeader(doc: NotebookDocumentApi, page: Page): string {
  const index = doc.pages().findIndex((p) => p.id === page.id) + 1
  const size = page.kind === 'fixed' && page.width && page.height ? ` ${page.width}x${page.height}` : ''
  return `PAGE ${index} ${quote(page.title || 'Untitled')} id=${page.id} (${page.kind}${size}, ${page.background.pattern})`
}

/** The outline of one page: header, the viewport and selection when known, then its objects. */
export function pageOutline(
  doc: NotebookDocumentApi,
  page: Page,
  opts: { viewport?: Rect | null; selection?: ObjectId[]; max?: number } = {},
): string {
  const head = [pageHeader(doc, page)]
  if (opts.viewport) head.push(`VIEWPORT ${fmtRect(opts.viewport)}`)
  if (opts.selection?.length) head.push(`SELECTED ${opts.selection.join(',')}`)
  const entries = pageEntries(doc, page.id)
  if (!entries.length) return [...head, '(empty page)'].join('\n')
  const budget = (opts.max ?? OUTLINE_MAX_CHARS) - head.join('\n').length - 1
  return [...head, renderEntries(entries, opts.viewport ?? null, budget)].join('\n')
}

export function notebookHeader(doc: NotebookDocumentApi): string {
  const meta = doc.meta()
  const tags = meta.tags.length ? ` tags: ${meta.tags.map((t) => quote(t, 40)).join(', ')}` : ''
  const theme = meta.theme ? ` theme: ${meta.theme}` : ''
  return `NOTEBOOK ${quote(meta.title || 'Untitled')} id=${doc.id} (${doc.pages().length} pages)${tags}${theme}`
}

/** A whole notebook: its header and every page's outline, sharing one character budget. */
export function notebookOutline(doc: NotebookDocumentApi, max = OUTLINE_MAX_CHARS): string {
  const pages = doc.pages()
  const parts = [notebookHeader(doc)]
  let left = max - parts[0].length
  const perPage = Math.max(600, Math.floor(left / Math.max(1, pages.length)))
  for (const [i, page] of pages.entries()) {
    if (left < 200) {
      parts.push(`… ${pages.length - i} more pages not shown (use get_page)`)
      break
    }
    const text = pageOutline(doc, page, { max: Math.min(perPage, left) })
    parts.push(text)
    left -= text.length + 1
  }
  return parts.join('\n')
}
