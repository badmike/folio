import { boundsUnion, rectIntersects, type NotebookDocumentApi, type ObjectId, type PageId, type Rect } from '@folio/document'
import type { ContextBuilder, ToolHost } from '../host'
import type { ContextChip } from '../protocol'
import { withDescendants } from './objects'
import { OUTLINE_MAX_CHARS, notebookOutline, pageEntries, pageHeader, pageOutline, renderEntries } from './outline'

const LIBRARY = 'LIBRARY: no notebook is open. Use search_notebooks to find content and read_notebook to read one.'
const MAX_LISTED_NOTEBOOKS = 200

/** Library outline: one line per notebook, so the model can pick ids for read_notebook. */
function libraryOutline(notebooks: { id: string; title: string; tags: string[] }[]): string {
  const lines = notebooks.slice(0, MAX_LISTED_NOTEBOOKS).map((n) => `[${n.id}] "${n.title || 'Untitled'}"${n.tags.length ? ` tags: ${n.tags.join(', ')}` : ''}`)
  const more = notebooks.length - lines.length
  return [LIBRARY, `NOTEBOOKS (${notebooks.length}):`, ...lines, ...(more > 0 ? [`… ${more} more, use search_notebooks`] : [])].join('\n')
}
/** How far around a prompt note its neighbours count as context. */
const NEARBY = 240

const pageTitle = (doc: NotebookDocumentApi, pageId: PageId) => {
  const pages = doc.pages()
  const i = pages.findIndex((p) => p.id === pageId)
  return pages[i]?.title || `Page ${i + 1}`
}

/** Header plus the lines of the given objects (groups with their members), nearest to `near` first. */
function objectsContent(doc: NotebookDocumentApi, pageId: PageId, ids: ObjectId[], near: Rect | null = null): string {
  const page = doc.page(pageId)
  if (!page) return '(page not found)'
  const only = new Set(withDescendants(doc, pageId, ids))
  const head = pageHeader(doc, page)
  return `${head}\n${renderEntries(pageEntries(doc, pageId, only), near, OUTLINE_MAX_CHARS - head.length - 1) || '(no objects)'}`
}

/** Objects in the frame, found by membership. */
const frameMembers = (doc: NotebookDocumentApi, pageId: PageId, frameId: ObjectId) =>
  [frameId, ...doc.objects(pageId).filter((o) => o.frameId === frameId).map((o) => o.id)]

/** The prompt note and everything within NEARBY of it. */
function promptNoteMembers(doc: NotebookDocumentApi, pageId: PageId, ids: ObjectId[]): { ids: ObjectId[]; near: Rect | null } {
  const entries = pageEntries(doc, pageId)
  const note = boundsUnion(pageEntries(doc, pageId, new Set(ids)).map((e) => e.bounds))
  if (!note) return { ids, near: null }
  const zone = { x: note.x - NEARBY, y: note.y - NEARBY, width: note.width + 2 * NEARBY, height: note.height + 2 * NEARBY }
  const nearby = entries.filter((e) => rectIntersects(e.bounds, zone)).flatMap((e) => e.members)
  return { ids: [...ids, ...nearby], near: note }
}

export const contextBuilder: ContextBuilder = {
  async environment(host) {
    const view = host.view()
    if (!view) return { notebookId: null, notebookTitle: null, pageId: null, viewport: null, outline: libraryOutline(await host.notebooks()) }
    return host.withNotebook(view.notebookId, (doc) => {
      const page = doc.page(view.pageId)
      return {
        notebookId: view.notebookId,
        notebookTitle: doc.meta().title,
        pageId: view.pageId,
        viewport: view.viewport,
        outline: page ? pageOutline(doc, page, { viewport: view.viewport, selection: view.selection }) : '(page not found)',
      }
    })
  },

  async selectionChip(host) {
    const view = host.view()
    if (!view?.selection.length) return null
    const { notebookId, pageId, selection } = view
    return host.withNotebook(notebookId, (doc) => ({
      kind: 'selection',
      label: `${selection.length} selected`,
      ref: { notebookId, pageId, objectIds: selection },
      content: objectsContent(doc, pageId, selection, view.viewport),
    }))
  },

  async pageChip(host) {
    const view = host.view()
    if (!view) return null
    return chipFor(host, { notebookId: view.notebookId, pageId: view.pageId }, 'page')
  },

  mentionChip: (host, ref, kind) => chipFor(host, ref, kind),
}

function chipFor(host: ToolHost, ref: ContextChip['ref'], kind: ContextChip['kind']): Promise<ContextChip> {
  return host.withNotebook(ref.notebookId, (doc): ContextChip => {
    const view = host.view()
    const viewport = view?.notebookId === ref.notebookId && view.pageId === ref.pageId ? view.viewport : null
    const page = ref.pageId ? doc.page(ref.pageId) : undefined
    const ids = ref.objectIds ?? []
    if (kind === 'notebook' || !page) {
      return { kind, label: doc.meta().title || 'Untitled notebook', ref, content: notebookOutline(doc) }
    }
    switch (kind) {
      case 'page':
        return { kind, label: pageTitle(doc, page.id), ref, content: pageOutline(doc, page, { viewport }) }
      case 'frame': {
        const frame = ids[0] ? doc.object(page.id, ids[0]) : undefined
        const label = frame?.type === 'shape' && frame.label?.trim() ? frame.label : 'Frame'
        return { kind, label, ref, content: objectsContent(doc, page.id, ids.flatMap((id) => frameMembers(doc, page.id, id))) }
      }
      case 'prompt_note': {
        const { ids: members, near } = promptNoteMembers(doc, page.id, ids)
        return { kind, label: 'Prompt note', ref, content: objectsContent(doc, page.id, members, near) }
      }
      case 'selection':
        return { kind, label: `${ids.length} selected`, ref, content: objectsContent(doc, page.id, ids, viewport) }
    }
  })
}
