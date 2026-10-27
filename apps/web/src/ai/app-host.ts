/**
 * The app's ToolHost: how the AI tools reach notebooks. The open notebook goes through its controller
 * (editor, undo grouping, highlights); any other notebook through a temporary workspace session.
 * `approve` and `ask` are answered per thread by the session (see `BaseHost`).
 */
import type { NotebookDocumentApi, NotebookId, Operation, PageId, Rect } from '@folio/document'
import type { NotebookController } from '../notebook'
import { exportBounds, renderPage } from '../services/export'
import { assetImageResolver } from '../services/images'
import { notebookThemeId, themeFor } from '../services/themes'
import type { NotebookSession, Workspace } from '../services/workspace'
import type { BaseHost } from './session'

/** Longest side of a rendered image, the vision models' sweet spot. */
export const MAX_RENDER_PX = 1568

export function createAppHost(ws: Workspace, ctl: () => NotebookController | null): BaseHost {
  /** Sessions held open by a running `withNotebook`, so `apply` can write to them synchronously. */
  const held = new Map<NotebookId, NotebookSession>()
  /** Writes to closed notebooks, in order; `withNotebook` waits for them. */
  const writes = new Map<NotebookId, Promise<void>>()

  const open = (id: NotebookId) => {
    const c = ctl()
    return c && c.id === id ? c : null
  }

  async function withSession<T>(id: NotebookId, fn: (s: NotebookSession) => T | Promise<T>): Promise<T> {
    const s = await ws.openNotebook(id)
    try { return await fn(s) } finally { await ws.release(id) }
  }

  return {
    view() {
      const c = ctl()
      const viewport = c?.viewRect()
      const e = c?.editor.value
      if (!c || !viewport || !e) return null
      return { notebookId: c.id, pageId: c.pageId.value, viewport, selection: [...e.selection] }
    },

    async withNotebook<T>(id: NotebookId, fn: (doc: NotebookDocumentApi) => T | Promise<T>): Promise<T> {
      const c = open(id)
      if (c) return fn(c.doc)
      await writes.get(id)
      const outer = held.get(id)
      if (outer) return fn(outer.doc)
      return withSession(id, async (s) => {
        held.set(id, s)
        try { return await fn(s.doc) } finally { held.delete(id) }
      })
    },

    apply(notebookId: NotebookId, ops: Operation[], turnId: string) {
      const c = open(notebookId)
      if (c) return c.applyAi(ops, turnId)
      const s = held.get(notebookId)
      if (s) return s.apply(ops)
      const prev = writes.get(notebookId) ?? Promise.resolve()
      const next = prev.then(() => withSession(notebookId, (x) => x.apply(ops)))
      writes.set(notebookId, next)
      void next.finally(() => { if (writes.get(notebookId) === next) writes.delete(notebookId) })
    },

    search: (query, limit) => ws.search(query, limit),

    async render(notebookId: NotebookId, pageId: PageId, region?: Rect) {
      const c = open(notebookId)
      const draw = async (doc: NotebookDocumentApi) => {
        const page = doc.page(pageId)
        if (!page) throw new Error(`Unknown page ${pageId}`)
        const bounds = region ?? exportBounds(doc, page)
        const scale = Math.min(2, MAX_RENDER_PX / Math.max(1, bounds.width, bounds.height))
        const e = c?.editor.value
        if (e) return e.exportImage({ pageId, scale, bounds })
        const theme = themeFor(notebookThemeId(doc.meta()))
        return renderPage(doc, pageId, { scale, bounds, theme, resolveImage: assetImageResolver(ws) })
      }
      const blob = c ? await draw(c.doc) : await withSession(notebookId, (s) => draw(s.doc))
      return blobToBase64(blob)
    },

    async asset(assetId: string) {
      const a = await ws.storage.getAsset(assetId)
      if (!a) return undefined
      const size = await imageSize(new Blob([a.bytes as BlobPart], { type: a.mimeType }))
      return size && { mimeType: a.mimeType, ...size }
    },

    highlight(notebookId, pageId, ids, zoom) {
      open(notebookId)?.flash(pageId, ids, !!zoom)
    },
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function imageSize(blob: Blob): Promise<{ width: number; height: number } | undefined> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { width: img.naturalWidth, height: img.naturalHeight }
  } catch {
    return undefined
  } finally {
    URL.revokeObjectURL(url)
  }
}
