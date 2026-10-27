import type { NotebookId } from '@folio/document'
import type { CreateToolRunner } from '../host'
import { TOOL_NAMES, type ToolName } from '../protocol'
import { ask_user } from './ask'
import { draw_diagram } from './diagram'
import type { Executor, ToolCtx } from './kit'
import { quote } from './outline'
import { add_page, delete_page, update_notebook, update_page } from './pages'
import { get_page, list_pages, look, read_notebook, read_objects, search_notebooks } from './read'
import { ToolError } from './validate'
import { connect, create_shapes, create_text, delete_objects, group_objects, insert_image, move_objects, update_objects } from './write'

const EXECUTORS: Record<ToolName, Executor> = {
  list_pages, get_page, read_objects, look, search_notebooks, read_notebook,
  create_shapes, create_text, connect, update_objects, move_objects, delete_objects,
  group_objects, draw_diagram, insert_image, add_page, update_page, delete_page, update_notebook,
  ask_user,
}

const isToolName = (name: string): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name)

const DECLINED = 'The user declined. Do not retry this change; ask what they want instead or continue without it.'

/**
 * One runner per thread. It keeps the thread's "Allow for this thread" approvals, so writes to a
 * notebook the user allowed once for the thread no longer ask.
 */
export const createToolRunner: CreateToolRunner = (host) => {
  const allowed = new Set<NotebookId>()

  const authorize = async (notebookId: NotebookId) => {
    if (notebookId === host.view()?.notebookId || allowed.has(notebookId)) return
    const title = await host.withNotebook(notebookId, (doc) => doc.meta().title)
    const decision = await host.approve({ kind: 'other_notebook', notebookId, summary: `Edit the notebook ${quote(title || 'Untitled')}` })
    if (decision === 'deny') throw new ToolError(DECLINED)
    if (decision === 'thread') allowed.add(notebookId)
  }

  const confirm: ToolCtx['confirm'] = async (req) => {
    if ((await host.approve(req)) === 'deny') throw new ToolError(DECLINED)
  }

  return {
    async run(call, turnId) {
      const fail = (message: string) => ({ toolCallId: call.toolCallId, output: { error: message }, isError: true, effects: [] })
      if (!isToolName(call.name)) return fail(`unknown tool ${call.name}`)
      try {
        const { output, image, effects } = await EXECUTORS[call.name](call.input, { host, turnId, authorize, confirm })
        return { toolCallId: call.toolCallId, output, isError: false, image, effects: effects ?? [] }
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }
}
