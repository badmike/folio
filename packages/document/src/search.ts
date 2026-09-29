import type { NotebookDocumentApi } from './api'
import { worldBounds } from './geometry'
import { activeRecognitions } from './semantic'
import type { ArrowObject, Rect, ShapeObject, TextObject } from './types'

/** Structurally identical to persistence's SearchDoc (kept local to avoid a package dependency). */
export interface SearchDocShape {
  notebookId: string
  pageId: string | null
  objectId: string | null
  kind: 'title' | 'tag' | 'text' | 'handwriting' | 'label'
  text: string
  bounds?: Rect
}

/** Searchable documents for a notebook: title, tags, page titles, text, handwriting, labels. */
export function searchDocsFor(doc: NotebookDocumentApi): SearchDocShape[] {
  const meta = doc.meta()
  const nb = meta.id
  const out: SearchDocShape[] = []
  if (meta.title.trim()) out.push({ notebookId: nb, pageId: null, objectId: null, kind: 'title', text: meta.title })
  for (const tag of meta.tags) if (tag.trim()) out.push({ notebookId: nb, pageId: null, objectId: null, kind: 'tag', text: tag })
  for (const page of doc.pages()) {
    if (page.title.trim()) out.push({ notebookId: nb, pageId: page.id, objectId: null, kind: 'title', text: page.title })
    const objs = doc.objects(page.id)
    const resolve = (id: string) => objs.find((o) => o.id === id)
    for (const o of objs) {
      if (o.supersededBy) continue
      if (o.type === 'text') {
        const t = (o as TextObject).text
        if (t.trim()) out.push({ notebookId: nb, pageId: page.id, objectId: o.id, kind: 'text', text: t, bounds: worldBounds(o, resolve) })
      } else if (o.type === 'shape' || o.type === 'arrow') {
        const l = (o as ShapeObject | ArrowObject).label
        if (l?.trim()) out.push({ notebookId: nb, pageId: page.id, objectId: o.id, kind: 'label', text: l, bounds: worldBounds(o, resolve) })
      }
    }
    for (const r of activeRecognitions(doc, page.id)) {
      if (r.kind !== 'text') continue
      const text = r.refinedText ?? r.text
      if (text?.trim()) out.push({ notebookId: nb, pageId: page.id, objectId: r.id, kind: 'handwriting', text, bounds: r.bounds })
    }
  }
  return out
}
