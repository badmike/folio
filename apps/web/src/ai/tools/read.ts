import { INK_POINT_STRIDE, activeRecognitions, worldBounds, type CanvasObject, type NotebookDocumentApi, type PageId } from '@folio/document'
import { tool, notebookOf, pageOf, type Executor } from './kit'
import { notebookOutline, pageOutline, roundRect, resolverFor } from './outline'
import { ToolError, arr, id, int, obj, opt, rect, str, where } from './validate'

/** Rounds numbers to two decimals so details stay compact. */
const compact = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)))

/** Full detail of one object; ink is summarised as bounds plus recognized text, never points. */
function detail(doc: NotebookDocumentApi, pageId: PageId, o: CanvasObject): unknown {
  const bounds = roundRect(worldBounds(o, resolverFor(doc, pageId)))
  if (o.type !== 'ink') return compact({ ...o, bounds })
  const { points, ...rest } = o
  const rec = activeRecognitions(doc, pageId).find((r) => r.strokeIds.includes(o.id))
  const recognized = rec ? { id: rec.id, kind: rec.kind, text: rec.refinedText ?? rec.text, shape: rec.shape } : undefined
  return compact({ ...rest, bounds, pointCount: points.length / INK_POINT_STRIDE, recognized })
}

export const list_pages: Executor = tool(obj({ notebookId: opt(id) }), async (input, { host }) => {
  const notebookId = notebookOf(host, input.notebookId)
  const view = host.view()
  return {
    output: await host.withNotebook(notebookId, (doc) => ({
      notebookId,
      title: doc.meta().title,
      currentPageId: view?.notebookId === notebookId ? view.pageId : undefined,
      pages: doc.pages().map((p, i) => ({
        id: p.id, index: i + 1, title: p.title, kind: p.kind,
        objects: doc.objects(p.id).filter((o) => !o.supersededBy).length,
      })),
    })),
  }
})

export const get_page: Executor = tool(obj(where), async (input, { host }) => {
  const notebookId = notebookOf(host, input.notebookId)
  return {
    output: await host.withNotebook(notebookId, (doc) => {
      const { page, viewport, selection } = pageOf(host, doc, input.pageId)
      return { notebookId, pageId: page.id, outline: pageOutline(doc, page, { viewport, selection }) }
    }),
  }
})

export const read_objects: Executor = tool(obj({ ...where, ids: arr(id, { min: 1, max: 50 }) }), async (input, { host }) => {
  const notebookId = notebookOf(host, input.notebookId)
  return {
    output: await host.withNotebook(notebookId, (doc) => {
      const { page } = pageOf(host, doc, input.pageId)
      const recs = new Map(doc.recognitions(page.id).map((r) => [r.id, r]))
      const missing: string[] = []
      const objects = input.ids.flatMap((oid) => {
        const o = doc.object(page.id, oid)
        if (o) return [detail(doc, page.id, o)]
        const r = recs.get(oid)
        if (r) return [compact({ id: r.id, type: 'handwriting', kind: r.kind, text: r.refinedText ?? r.text, shape: r.shape, bounds: r.bounds, strokeIds: r.strokeIds })]
        missing.push(oid)
        return []
      })
      return { notebookId, pageId: page.id, objects, missing: missing.length ? missing : undefined }
    }),
  }
})

export const look: Executor = tool(obj({ ...where, region: opt(rect) }), async (input, { host }) => {
  const notebookId = notebookOf(host, input.notebookId)
  const pageId = await host.withNotebook(notebookId, (doc) => pageOf(host, doc, input.pageId).page.id)
  const image = await host.render(notebookId, pageId, input.region)
  return {
    output: { notebookId, pageId, region: input.region ? roundRect(input.region) : 'page content', note: 'The rendered image is attached.' },
    image,
  }
})

export const search_notebooks: Executor = tool(
  obj({ query: str({ min: 1, max: 200 }), limit: opt(int({ min: 1, max: 50 })) }),
  async (input, { host }) => {
    const hits = await host.search(input.query, input.limit ?? 20)
    return {
      output: {
        hits: hits.map((h) => ({
          notebookId: h.notebookId, pageId: h.pageId ?? undefined, objectId: h.objectId ?? undefined, kind: h.kind,
          snippet: (h.snippet || h.text).slice(0, 200), bounds: h.bounds ? roundRect(h.bounds) : undefined,
        })),
      },
    }
  },
)

export const read_notebook: Executor = tool(obj({ notebookId: id }), async (input, { host }) => ({
  output: await host.withNotebook(input.notebookId, (doc) => {
    if (!doc.pages().length) throw new ToolError(`notebook ${input.notebookId} has no pages or does not exist`)
    return { notebookId: input.notebookId, outline: notebookOutline(doc) }
  }),
}))
