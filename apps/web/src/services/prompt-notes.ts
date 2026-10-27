/**
 * Prompt notes: handwriting that starts with `@ai` (recognized text on a page) can be sent to the AI with
 * one tap. Which note started which thread is device state in localStorage, so the doc schema stays as is.
 */
import type { NotebookDocumentApi, ObjectId, PageId, Rect } from '@folio/document'

export interface PromptNote {
  /** Stable while the same strokes form the note. */
  key: string
  strokeIds: ObjectId[]
  bounds: Rect
  /** The request without the `@ai` prefix. */
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

/** Prompt notes among the text recognitions of a page whose ink is still there (not cleaned up). */
export function findPromptNotes(doc: NotebookDocumentApi, pageId: PageId): PromptNote[] {
  const live = (id: ObjectId) => {
    const o = doc.object(pageId, id)
    return o?.type === 'ink' && !o.supersededBy
  }
  return doc.recognitions(pageId).flatMap((r) => {
    if (r.kind !== 'text' || !r.strokeIds.length || !r.strokeIds.every(live)) return []
    const text = promptNoteBody(r.refinedText ?? '') ?? promptNoteBody(r.text ?? '')
    return text ? [{ key: [...r.strokeIds].sort().join(','), strokeIds: r.strokeIds, bounds: r.bounds, text }] : []
  })
}

const MAX_STORED = 200
const storeKey = (notebookId: string) => `folio.ai.promptNotes.${notebookId}`

/** Note key -> thread id for one notebook. */
export function promptNoteThreads(notebookId: string): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(storeKey(notebookId)) ?? '{}')
    if (typeof v !== 'object' || v === null) return {}
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return {}
  }
}

/** Remember the thread a note started; the oldest entries go beyond MAX_STORED. Returns the new map. */
export function savePromptNoteThread(notebookId: string, key: string, threadId: string): Record<string, string> {
  const rest = Object.entries(promptNoteThreads(notebookId)).filter(([k]) => k !== key)
  const next = Object.fromEntries([...rest, [key, threadId]].slice(-MAX_STORED))
  try { localStorage.setItem(storeKey(notebookId), JSON.stringify(next)) } catch { /* private mode: badge lasts this visit */ }
  return next
}
