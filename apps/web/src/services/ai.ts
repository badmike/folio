import {
  createId, identityTransform, summarizeForAI, worldBounds,
  type NotebookDocumentApi, type PageId, type Rect, type TextObject,
} from '@folio/document'
import type { Editor } from '@folio/editor'
import type { AuthService } from './auth'
import { runtimeConfig } from './runtime-config'
import type { NotebookSession } from './workspace'

export type AiKind = 'page' | 'lecture' | 'outline' | 'flashcards' | 'questions' | 'ask'

export const AI_KINDS: { kind: AiKind; label: string; hint: string }[] = [
  { kind: 'page', label: 'Summarize page', hint: 'Short summary of the current page' },
  { kind: 'lecture', label: 'Lecture notes', hint: 'Structured notes from the whole notebook' },
  { kind: 'outline', label: 'Outline', hint: 'Hierarchical outline of the whole notebook' },
  { kind: 'flashcards', label: 'Flashcards', hint: 'Question/answer cards from the whole notebook' },
  { kind: 'questions', label: 'Practice questions', hint: 'Questions with answers' },
]

export class AiError extends Error {
  override name = 'AiError'
}

/** Why AI is unavailable right now, or null when it can be used. */
export function aiDisabledReason(auth: Pick<AuthService, 'signedIn' | 'online'>): string | null {
  if (!runtimeConfig.apiBase) return 'AI needs a folio server.'
  if (!auth.online.value) return 'AI needs an internet connection.'
  if (!auth.signedIn.value) return 'Create an account and sign in to use AI features.'
  return null
}

/** Reduce a summarizeForAI() document to the header plus one page's section. */
export function contextForPage(full: string, pageIndex: number): string {
  const lines = full.split('\n')
  const header = lines[0] ?? ''
  const marker = `--- PAGE ${pageIndex + 1}`
  const start = lines.findIndex((l) => l.startsWith(marker))
  if (start < 0) return full
  let end = lines.findIndex((l, i) => i > start && l.startsWith('--- PAGE '))
  if (end < 0) end = lines.length
  return [header, ...lines.slice(start, end)].join('\n')
}

async function post<T>(auth: AuthService, path: string, body: unknown): Promise<T> {
  const token = await auth.getToken()
  let res: Response
  try {
    res = await fetch(`${runtimeConfig.apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  } catch {
    throw new AiError('Could not reach the folio server.')
  }
  if (!res.ok) {
    let code = ''
    try { code = ((await res.json()) as { error?: string }).error ?? '' } catch { /* ignore */ }
    if (res.status === 503 || code === 'ai_not_configured') throw new AiError('AI is not configured on the server.')
    if (res.status === 401) throw new AiError('Please sign in again.')
    if (res.status === 429) throw new AiError('Daily AI limit reached. Try again later.')
    throw new AiError(`AI request failed (${res.status}).`)
  }
  return (await res.json()) as T
}

/** Ask the AI gateway; returns Markdown. */
export async function runAi(
  auth: AuthService, doc: NotebookDocumentApi, pageId: PageId, kind: AiKind, question?: string,
): Promise<string> {
  const full = summarizeForAI(doc)
  if (kind === 'ask') {
    const q = question?.trim()
    if (!q) throw new AiError('Type a question first.')
    return (await post<{ markdown: string }>(auth, '/ai/ask', { question: q, context: full })).markdown
  }
  const context = kind === 'page' ? contextForPage(full, Math.max(0, doc.pages().findIndex((p) => p.id === pageId))) : full
  return (await post<{ markdown: string }>(auth, '/ai/summarize', { context, kind })).markdown
}

/** Where AI output goes: right of the content on infinite pages, below it on fixed pages. */
export function placementForAiOutput(doc: NotebookDocumentApi, pageId: PageId, width = 480): { x: number; y: number; width: number } {
  const page = doc.page(pageId)
  const objs = doc.objects(pageId)
  const byId = new Map(objs.map((o) => [o.id, o]))
  let minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let any = false
  for (const o of objs) {
    if (o.supersededBy || o.type === 'group') continue
    const b: Rect = worldBounds(o, (id) => byId.get(id))
    any = true
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }
  if (page?.kind === 'fixed' && page.width && page.height) {
    const w = Math.min(width, page.width - 80)
    return { x: 40, y: Math.min(any ? maxY + 40 : 40, Math.max(40, page.height - 120)), width: w }
  }
  return any ? { x: maxX + 80, y: minY, width } : { x: 0, y: 0, width }
}

/** Insert Markdown as a normal, undoable TextObject and bring it into view. */
export function insertAiResult(session: NotebookSession, editor: Editor | null, pageId: PageId, markdown: string): string {
  const place = placementForAiOutput(session.doc, pageId)
  const now = Date.now()
  const z = session.doc.objects(pageId).reduce((m, o) => Math.max(m, o.z), 0) + 1
  const obj: TextObject = {
    id: createId(), type: 'text', text: markdown.trim(), fontSize: 16, fontFamily: 'sans', color: '#1e1e1e',
    width: place.width, semanticType: 'paragraph', z, createdAt: now, updatedAt: now,
    transform: { ...identityTransform(), x: place.x, y: place.y },
  }
  const ops = [{ type: 'addObjects' as const, pageId, objects: [obj] }]
  if (editor && editor.pageId === pageId) {
    editor.execute(ops)
    editor.select([obj.id])
    const b = editor.selectionBounds()
    if (b) editor.zoomToRect(b, 64)
  } else {
    session.apply(ops)
  }
  return obj.id
}
