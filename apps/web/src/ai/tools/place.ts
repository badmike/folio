import {
  boundsUnion, rectIntersects, worldBounds,
  type CanvasObject, type NotebookDocumentApi, type ObjectResolver, type Page, type Rect, type Vec2,
} from '@folio/document'
import { frameLabelRect } from '@folio/renderer'

/** Room inside the viewport's edges, clear of the floating menu button and toolbar. */
const MARGIN = 64
const CLEARANCE = 24

/** World bounds plus, for a titled frame, the title the renderer draws above its top edge. */
export function footprint(o: CanvasObject, resolve: ObjectResolver): Rect {
  const b = worldBounds(o, resolve)
  if (o.type !== 'shape' || o.kind !== 'frame' || !o.label) return b
  const title = frameLabelRect(o).height
  return { ...b, y: b.y - title, height: b.height + title }
}

/**
 * Top-left for a `width` × `height` block in free space: the first gap in the viewport (row by row),
 * else beside what is already there. Without a viewport, fixed pages use the page and infinite pages
 * go right of the content.
 */
export function freeSpot(doc: NotebookDocumentApi, page: Page, viewport: Rect | null, width: number, height: number): Vec2 {
  const fixed = page.kind === 'fixed' && page.width && page.height ? { x: 0, y: 0, width: page.width, height: page.height } : null
  const area = viewport ?? fixed
  const objs = doc.objects(page.id)
  const resolve = (id: string) => doc.object(page.id, id)
  const taken = objs.filter((o) => !o.supersededBy && o.type !== 'group').map((o) => footprint(o, resolve))

  if (area) {
    const near = taken.filter((b) => rectIntersects(b, area))
    const step = Math.max(24, area.width / 80, area.height / 80)
    for (let y = area.y + MARGIN; y + height <= area.y + area.height - MARGIN; y += step) {
      for (let x = area.x + MARGIN; x + width <= area.x + area.width - MARGIN; x += step) {
        const box = { x: x - CLEARANCE, y: y - CLEARANCE, width: width + 2 * CLEARANCE, height: height + 2 * CLEARANCE }
        if (!near.some((b) => rectIntersects(b, box))) return { x, y }
      }
    }
  }

  const content = boundsUnion(taken)
  if (!content) return area ? { x: area.x + MARGIN, y: area.y + MARGIN } : { x: 0, y: 0 }
  if (fixed && !viewport) return { x: MARGIN, y: content.y + content.height + MARGIN }
  if (!viewport) return { x: content.x + content.width + 80, y: content.y }
  // right of whatever shares the viewport's rows
  const band = { x: -1e9, y: viewport.y, width: 2e9, height: Math.max(height, viewport.height) }
  const right = taken.filter((b) => rectIntersects(b, band)).reduce((m, b) => Math.max(m, b.x + b.width), viewport.x)
  return { x: right + 80, y: viewport.y + MARGIN }
}
