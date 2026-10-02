/** Default wiring to the real @folio/renderer implementations. */
import type { CanvasObject, NotebookDocumentApi, PageId, Rect } from '@folio/document'
import { ImageCache, createLiveInkLayer, createRenderer, renderPageToImage } from '@folio/renderer'
import type { ImageResolver, LiveInkLayer, Renderer, VisualTheme } from '@folio/renderer'
import { unionRects, worldBounds } from './geometry'
import type { RendererFactoryOptions } from './types'

export function createDefaultRenderer(o: RendererFactoryOptions): Renderer {
  return createRenderer(o.canvas, { prefer: o.kind })
}

export function createDefaultLiveLayer(canvas: HTMLCanvasElement): LiveInkLayer {
  return createLiveInkLayer(canvas)
}

/** Render a page (or a region) of the document to a PNG blob. */
export async function exportPageImage(
  doc: NotebookDocumentApi,
  pageId: PageId,
  o: { scale: number; bounds?: Rect; theme: VisualTheme; resolveImage?: ImageResolver },
): Promise<Blob> {
  const page = doc.page(pageId)
  if (!page) throw new Error(`Unknown page ${pageId}`)
  const objects = doc.objects(pageId).filter((x) => !x.supersededBy && x.type !== 'group')
  const byId = new Map<string, CanvasObject>(doc.objects(pageId).map((x) => [x.id, x]))
  const resolve = (id: string) => byId.get(id)
  let bounds = o.bounds
  if (!bounds) {
    if (page.kind === 'fixed' && page.width && page.height) bounds = { x: 0, y: 0, width: page.width, height: page.height }
    else {
      const u = unionRects(objects.map((x) => worldBounds(x, resolve)).filter((r): r is Rect => !!r))
      const pad = 32
      bounds = u ? { x: u.x - pad, y: u.y - pad, width: u.width + pad * 2, height: u.height + pad * 2 } : { x: 0, y: 0, width: 800, height: 600 }
    }
  }
  const images = new ImageCache()
  images.setResolver(o.resolveImage ?? null)
  await images.preload(objects.flatMap((x) => (x.type === 'image' ? [x.assetId] : [])))
  return renderPageToImage(
    { page, objects, resolve, theme: o.theme },
    { bounds, scale: o.scale, background: true, images },
  )
}
