import {
  boundsUnion, rectContains, worldBounds,
  type NotebookDocumentApi, type NotebookId, type ObjectId, type Operation, type Page, type PageId, type Rect,
} from '@folio/document'
import type { ApprovalRequest, ToolHost } from '../host'
import type { ToolEffect } from '../protocol'
import { ToolError, parseInput, type Parser } from './validate'

/** What an executor gets besides its input. One per tool call. */
export interface ToolCtx {
  host: ToolHost
  turnId: string
  /** Resolves when writing to `notebookId` is allowed (asks for other notebooks); throws when declined. */
  authorize(notebookId: NotebookId): Promise<void>
  /** Asks the user to approve `req`; throws when declined. */
  confirm(req: ApprovalRequest): Promise<void>
}

export interface ToolOutcome {
  output: unknown
  image?: string
  effects?: ToolEffect[]
}

export type Executor = (input: unknown, ctx: ToolCtx) => Promise<ToolOutcome>

/** An executor that validates its input before running. */
export const tool = <T>(parser: Parser<T>, run: (input: T, ctx: ToolCtx) => Promise<ToolOutcome>): Executor =>
  async (input, ctx) => run(parseInput(parser, input), ctx)

/** The notebook a call targets: the given one, or the one the user looks at. */
export function notebookOf(host: ToolHost, notebookId: NotebookId | undefined): NotebookId {
  if (notebookId) return notebookId
  const view = host.view()
  if (!view) throw new ToolError('No notebook is open. Pass notebookId (find notebooks with search_notebooks).')
  return view.notebookId
}

export interface PageTarget {
  page: Page
  /** Visible world rect when the user looks at this page, otherwise null. */
  viewport: Rect | null
  selection: ObjectId[]
}

/** The page a call targets: the given one, the one the user looks at, or the notebook's first page. */
export function pageOf(host: ToolHost, doc: NotebookDocumentApi, pageId: PageId | undefined): PageTarget {
  const view = host.view()
  const current = view?.notebookId === doc.id ? view : null
  const id = pageId ?? current?.pageId ?? doc.pages()[0]?.id
  const page = id ? doc.page(id) : undefined
  if (!page) throw new ToolError(`page ${id} not found in notebook ${doc.id}. Call list_pages for valid page ids.`)
  const here = current?.pageId === page.id ? current : null
  return { page, viewport: here?.viewport ?? null, selection: here?.selection ?? [] }
}

export interface Change {
  ops: Operation[]
  /** Objects to highlight after applying, on `pageId`. */
  pageId?: PageId
  ids?: ObjectId[]
}

/**
 * Build and apply one tool's operations: authorize, compute the inverse against the state right
 * before applying, apply, then highlight (and bring into view what landed outside it).
 * `build` throws a ToolError to abort without changes.
 */
export async function mutate<R extends Change>(
  ctx: ToolCtx,
  notebookId: NotebookId,
  build: (doc: NotebookDocumentApi) => R,
  opts: { approved?: boolean } = {},
): Promise<{ result: R; effects: ToolEffect[] }> {
  if (!opts.approved) await ctx.authorize(notebookId)
  return ctx.host.withNotebook(notebookId, (doc) => {
    const result = build(doc)
    if (!result.ops.length) return { result, effects: [] }
    const inverse = doc.inverse(result.ops)
    ctx.host.apply(notebookId, result.ops, ctx.turnId)
    if (result.pageId && result.ids?.length) {
      ctx.host.highlight(notebookId, result.pageId, result.ids, outOfView(ctx.host, doc, result.pageId, result.ids))
    }
    return { result, effects: [{ notebookId, ops: result.ops, inverse }] }
  })
}

/** Whether objects on the page the user looks at reach outside the visible area. */
function outOfView(host: ToolHost, doc: NotebookDocumentApi, pageId: PageId, ids: ObjectId[]): boolean {
  const view = host.view()
  if (view?.notebookId !== doc.id || view.pageId !== pageId) return false
  const resolve = (id: ObjectId) => doc.object(pageId, id)
  const box = boundsUnion(ids.flatMap((id) => {
    const o = resolve(id)
    return o ? [worldBounds(o, resolve)] : []
  }))
  return !!box && !rectContains(view.viewport, box)
}
