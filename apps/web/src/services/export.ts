import {
  worldBounds, type CanvasObject, type NotebookDocumentApi, type Page, type PageId, type Rect,
} from '@folio/document'
import type { Editor } from '@folio/editor'
import { renderPageToImage, type VisualTheme } from '@folio/renderer'
import { downloadBlob } from './diagnostics'
import type { Workspace } from './workspace'

export function safeFilename(title: string, ext: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'notebook'
  return `${base}.${ext}`
}

/** Bounds to export for a page: the page rect for fixed pages, padded content bounds otherwise. */
export function exportBounds(doc: NotebookDocumentApi, page: Page, pad = 32): Rect {
  if (page.kind === 'fixed' && page.width && page.height) return { x: 0, y: 0, width: page.width, height: page.height }
  const objs = doc.objects(page.id)
  const byId = new Map(objs.map((o) => [o.id, o]))
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const o of objs) {
    if (o.supersededBy || o.type === 'group') continue
    const b = worldBounds(o, (id) => byId.get(id))
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height)
  }
  if (!isFinite(x0)) return { x: 0, y: 0, width: 800, height: 600 }
  return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 2 }
}

/** Render a page to PNG without needing a mounted editor. */
export function renderPage(doc: NotebookDocumentApi, pageId: PageId, opts: { scale: number; theme: VisualTheme; bounds?: Rect }): Promise<Blob> {
  const page = doc.page(pageId)
  if (!page) throw new Error(`Unknown page ${pageId}`)
  const all = doc.objects(pageId)
  const byId = new Map<string, CanvasObject>(all.map((o) => [o.id, o]))
  return renderPageToImage(
    { page, objects: all.filter((o) => !o.supersededBy && o.type !== 'group'), resolve: (id) => byId.get(id), theme: opts.theme },
    { bounds: opts.bounds ?? exportBounds(doc, page), scale: opts.scale, background: true },
  )
}

export function exportMarkdownFile(title: string, markdown: string): void {
  downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), safeFilename(title, 'md'))
}

export async function exportPng(doc: NotebookDocumentApi, pageId: PageId, theme: VisualTheme, editor?: Editor | null): Promise<void> {
  const page = doc.page(pageId)
  if (!page) return
  const bounds = exportBounds(doc, page)
  const blob = editor ? await editor.exportImage({ pageId, scale: 2, bounds }) : await renderPage(doc, pageId, { scale: 2, theme, bounds })
  const suffix = doc.pages().length > 1 ? ` - ${page.title || `page ${doc.pages().findIndex((p) => p.id === pageId) + 1}`}` : ''
  downloadBlob(blob, safeFilename(doc.meta().title + suffix, 'png'))
}

/** One PDF page per notebook page: fixed pages at their format size, infinite pages at content bounds. */
export async function buildPdf(doc: NotebookDocumentApi, theme: VisualTheme): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  let pdf: InstanceType<typeof jsPDF> | null = null
  for (const page of doc.pages()) {
    const bounds = exportBounds(doc, page)
    const w = Math.max(1, Math.round(bounds.width))
    const h = Math.max(1, Math.round(bounds.height))
    const orientation = w > h ? 'landscape' : 'portrait'
    if (!pdf) pdf = new jsPDF({ unit: 'px', format: [w, h], orientation, compress: true, hotfixes: ['px_scaling'] })
    else pdf.addPage([w, h], orientation)
    const png = new Uint8Array(await (await renderPage(doc, page.id, { scale: 2, theme, bounds })).arrayBuffer())
    pdf.addImage(png, 'PNG', 0, 0, w, h, undefined, 'FAST')
  }
  if (!pdf) pdf = new jsPDF()
  return pdf.output('blob')
}

export async function exportPdf(doc: NotebookDocumentApi, theme: VisualTheme): Promise<void> {
  downloadBlob(await buildPdf(doc, theme), safeFilename(doc.meta().title, 'pdf'))
}

export async function exportFolioFile(ws: Workspace, id: string, title: string): Promise<void> {
  const bytes = await ws.exportFolioBytes(id)
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), safeFilename(title, 'folio'))
}

export async function exportMarkdownFor(ws: Workspace, id: string, title: string): Promise<void> {
  exportMarkdownFile(title, await ws.exportMarkdownText(id))
}

export async function importFolioFile(ws: Workspace, file: File, folderId: string | null = null): Promise<string> {
  return ws.importFolioBytes(new Uint8Array(await file.arrayBuffer()), folderId)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** Small PNG data URL preview of a notebook's first page (library cards). */
export async function thumbnailDataUrl(doc: NotebookDocumentApi, theme: VisualTheme, maxSize = 360): Promise<string | null> {
  const first = doc.pages()[0]
  if (!first) return null
  const b = exportBounds(doc, first)
  const scale = Math.min(1, maxSize / Math.max(b.width, b.height))
  const blob = await renderPage(doc, first.id, { scale, theme, bounds: b })
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}
