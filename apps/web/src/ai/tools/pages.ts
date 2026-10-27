import { THEME_IDS, createPage, type BackgroundPattern, type NotebookDocumentApi, type NotebookMeta, type Operation, type Page, type PageFormat } from '@folio/document'
import { mutate, notebookOf, pageOf, tool, type Executor } from './kit'
import { quote } from './outline'
import { ToolError, arr, id, int, obj, oneOf, opt, str } from './validate'

const PATTERNS = [
  'blank', 'ruled', 'grid', 'dot', 'music', 'isometric', 'hex', 'cornell', 'handwriting', 'engineering', 'isodot', 'tablature', 'polar',
] as const satisfies readonly BackgroundPattern[]
const FORMATS = ['A4', 'Letter', 'iPad'] as const satisfies readonly PageFormat[]

/** An order value that puts a page at `index` among `pages` (excluding the page itself). */
function orderAt(pages: Page[], index: number): number {
  const i = Math.max(0, Math.min(index, pages.length))
  const before = pages[i - 1]?.order
  const after = pages[i]?.order
  if (before === undefined) return after === undefined ? 1 : after - 1
  return after === undefined ? before + 1 : (before + after) / 2
}

function pageLabel(doc: NotebookDocumentApi, page: Page): string {
  return `page ${doc.pages().indexOf(page) + 1} ${quote(page.title || 'Untitled')}`
}

export const add_page: Executor = tool(
  obj({
    notebookId: opt(id),
    title: opt(str({ max: 200 })),
    kind: opt(oneOf(['infinite', 'fixed'])),
    format: opt(oneOf(FORMATS)),
    background: opt(oneOf(PATTERNS)),
    after: opt(id),
  }),
  async (input, ctx) => {
    const notebookId = notebookOf(ctx.host, input.notebookId)
    const { result, effects } = await mutate(ctx, notebookId, (doc) => {
      const pages = doc.pages()
      const view = ctx.host.view()
      const afterId = input.after ?? (view?.notebookId === notebookId ? view.pageId : pages[pages.length - 1]?.id)
      const ref = afterId ? doc.page(afterId) : undefined
      if (input.after && !ref) throw new ToolError(`after: page ${input.after} not found. Call list_pages for valid ids.`)
      const index = ref ? pages.indexOf(ref) + 1 : pages.length
      // the new page keeps the paper of its neighbour (the theme's paper colour)
      const background = ref ? { ...ref.background, pattern: input.background ?? ref.background.pattern } : undefined
      const page = createPage({
        kind: input.kind ?? (input.format ? 'fixed' : 'infinite'), format: input.format, title: input.title,
        order: orderAt(pages, index), background,
      })
      if (input.background && !background) page.background = { ...page.background, pattern: input.background }
      return { ops: [{ type: 'addPage', page }] satisfies Operation[], page: { id: page.id, index: index + 1 } }
    })
    return { output: { pageId: result.page.id, index: result.page.index }, effects }
  },
)

export const update_page: Executor = tool(
  obj({
    notebookId: opt(id),
    pageId: opt(id),
    title: opt(str({ max: 200 })),
    background: opt(oneOf(PATTERNS)),
    position: opt(int({ min: 1, max: 10000 })),
  }),
  async (input, ctx) => {
    const notebookId = notebookOf(ctx.host, input.notebookId)
    if (input.title === undefined && !input.background && !input.position) throw new ToolError('nothing to change: give title, background or position')
    const { result, effects } = await mutate(ctx, notebookId, (doc) => {
      const { page } = pageOf(ctx.host, doc, input.pageId)
      const patch: Partial<Omit<Page, 'id'>> = { updatedAt: Date.now() }
      if (input.title !== undefined) patch.title = input.title
      if (input.background) patch.background = { ...page.background, pattern: input.background }
      if (input.position) patch.order = orderAt(doc.pages().filter((p) => p.id !== page.id), input.position - 1)
      return { ops: [{ type: 'updatePage', pageId: page.id, patch }] satisfies Operation[], pageId: page.id }
    })
    return { output: { pageId: result.pageId }, effects }
  },
)

export const delete_page: Executor = tool(obj({ notebookId: opt(id), pageId: id }), async (input, ctx) => {
  const notebookId = notebookOf(ctx.host, input.notebookId)
  const summary = await ctx.host.withNotebook(notebookId, (doc) => {
    const { page } = pageOf(ctx.host, doc, input.pageId)
    if (doc.pages().length < 2) throw new ToolError('cannot delete the only page of a notebook')
    return `Delete ${pageLabel(doc, page)}${notebookId === ctx.host.view()?.notebookId ? '' : ` in ${quote(doc.meta().title || 'Untitled')}`}`
  })
  await ctx.confirm({ kind: 'delete_page', notebookId, summary })
  const { effects } = await mutate(ctx, notebookId, (doc) => {
    const { page } = pageOf(ctx.host, doc, input.pageId)
    return { ops: [{ type: 'deletePage', pageId: page.id }] satisfies Operation[] }
  }, { approved: true })
  return { output: { deleted: input.pageId }, effects }
})

export const update_notebook: Executor = tool(
  obj({
    notebookId: opt(id),
    title: opt(str({ min: 1, max: 200 })),
    tags: opt(arr(str({ min: 1, max: 40 }), { max: 20 })),
    theme: opt(oneOf(THEME_IDS)),
  }),
  async (input, ctx) => {
    const notebookId = notebookOf(ctx.host, input.notebookId)
    const { title, tags, theme } = input
    if (title === undefined && !tags && !theme) throw new ToolError('nothing to change: give title, tags or theme')
    // explicit undefined would clear a field, so only set what was given
    const patch: Partial<Omit<NotebookMeta, 'id'>> = { updatedAt: Date.now() }
    if (title !== undefined) patch.title = title
    if (tags) patch.tags = [...new Set(tags)]
    if (theme) patch.theme = theme
    const { effects } = await mutate(ctx, notebookId, () => ({ ops: [{ type: 'updateMeta', patch }] satisfies Operation[] }))
    return { output: { notebookId, title: patch.title, tags: patch.tags, theme: patch.theme }, effects }
  },
)
