/**
 * Prompt notes: handwriting that starts with `@ai` (recognized text on a page) can be sent to the AI with
 * one tap. Which thread a note started is stored on the thread (its source note), so the doc schema stays as is.
 */
import type { NotebookDocumentApi, ObjectId, PageId, Recognition, Rect } from '@folio/document'

export interface PromptNote {
  /** The smallest stroke id of the note: stable while the note is edited, unique on the page. */
  key: string
  strokeIds: ObjectId[]
  bounds: Rect
  /** The request without the `@ai` prefix; one line per handwritten line. */
  text: string
}

/** `@ai`, `@AI:`, `@ ai -` and the like at the very start; `@aim` is not one. */
const PREFIX = /^\s*@\s*ai(?![\p{L}\p{N}_])[\s:;,.\-–—]*/iu

/** The text after an `@ai` prefix, or null when `text` is not a prompt note (or says nothing after it). */
export function promptNoteBody(text: string): string | null {
  const m = PREFIX.exec(text)
  if (!m) return null
  return text.slice(m[0].length).trim() || null
}

/** Recognition is per handwritten line: a line right below another and aligned with it belongs to the same note. */
function continues(above: Rect, below: Rect): boolean {
  const ref = Math.max(above.height, below.height)
  if (below.y - (above.y + above.height) > 1.2 * ref) return false
  const overlap = Math.min(above.x + above.width, below.x + below.width) - Math.max(above.x, below.x)
  return overlap >= 0.25 * Math.min(above.width, below.width) || Math.abs(above.x - below.x) <= 2 * ref
}

/** Prompt notes among the text recognitions of a page whose ink is still there (not cleaned up). */
export function findPromptNotes(doc: NotebookDocumentApi, pageId: PageId): PromptNote[] {
  const live = (id: ObjectId) => {
    const o = doc.object(pageId, id)
    return o?.type === 'ink' && !o.supersededBy
  }
  const lines = doc.recognitions(pageId)
    .filter((r) => r.kind === 'text' && r.strokeIds.length && r.strokeIds.every(live))
    .sort((a, b) => a.bounds.y - b.bounds.y)
  const textOf = (r: Recognition) => (r.refinedText?.trim() ? r.refinedText : r.text ?? '').trim()
  const startOf = (r: Recognition) => [r.refinedText, r.text].find((t) => t !== undefined && PREFIX.test(t))
  const taken = new Set<Recognition>()
  const notes: PromptNote[] = []
  for (const [i, head] of lines.entries()) {
    const start = startOf(head)
    if (start === undefined) continue
    const rows = [head]
    const parts = [start.replace(PREFIX, '')]
    for (const next of lines.slice(i + 1)) {
      const last = rows[rows.length - 1].bounds
      if (taken.has(next) || startOf(next) !== undefined || !continues(last, next.bounds)) continue
      rows.push(next)
      parts.push(textOf(next))
    }
    const text = parts.map((p) => p.trim()).filter(Boolean).join('\n')
    if (!text) continue
    rows.forEach((r) => taken.add(r))
    const strokeIds = rows.flatMap((r) => r.strokeIds)
    const bounds = rows.map((r) => r.bounds).reduce((a, b) => {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
      return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
    })
    notes.push({ key: strokeIds.reduce((a, b) => (b < a ? b : a)), strokeIds, bounds, text })
  }
  return notes
}
