/**
 * Timeline rows derived from a thread's turns and items (T3 Code style): nothing about the UI is stored,
 * so new tools need no schema change. Consecutive tool calls fold into one summarised row.
 */
import type { NotebookId, ObjectId, Operation, PageId } from '@folio/document'
import type { Phase } from './session'
import type { ThreadItem, ToolCall, ToolEffect, ToolName, ToolResult, TurnInfo, UserMessage } from './protocol'

/** Objects a tool touched on one page; clicking a tool row highlights them. */
export interface ToolTarget { notebookId: NotebookId; pageId: PageId; ids: ObjectId[] }

export interface ToolRow {
  id: string
  call: ToolCall
  result: ToolResult | null
  label: string
  state: 'running' | 'done' | 'error'
  target: ToolTarget | null
}

export type TurnEndState = 'failed' | 'partial' | 'cancelled' | 'interrupted' | 'remote'

export type TimelineRow =
  /** `steer`: sent while the turn ran. Reverting goes to the turn's first message, so steer rows offer no revert. */
  | { kind: 'user'; id: string; turnId: string; message: UserMessage; local: boolean; steer: boolean }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'tools'; id: string; summary: string; tools: ToolRow[]; running: boolean }
  | { kind: 'turn_end'; id: string; turn: TurnInfo; state: TurnEndState; message: string }
  | { kind: 'failure'; id: string; message: string }
  | { kind: 'working'; id: string; since: number; label: string }

export interface TimelineInput {
  items: readonly ThreadItem[]
  turns: readonly TurnInfo[]
  phase: Phase
  activeTurnId: string | null
  startedAt: number
  deviceId: string
  failure: { message: string } | null
  /** An approval or ask_user waits for the user. */
  waiting?: boolean
  maxSteps?: number
}

export const TOOL_LABELS: Record<ToolName, string> = {
  list_pages: 'Listed the pages',
  get_page: 'Read a page',
  read_objects: 'Read objects',
  look: 'Looked at the page',
  search_notebooks: 'Searched notebooks',
  read_notebook: 'Read a notebook',
  create_shapes: 'Added shapes',
  create_text: 'Added text',
  connect: 'Connected objects',
  update_objects: 'Updated objects',
  move_objects: 'Moved objects',
  delete_objects: 'Deleted objects',
  group_objects: 'Grouped objects',
  draw_diagram: 'Drew a diagram',
  insert_image: 'Inserted an image',
  add_page: 'Added a page',
  update_page: 'Updated a page',
  delete_page: 'Deleted a page',
  update_notebook: 'Updated the notebook',
  ask_user: 'Asked you',
}

function toolLabel(call: ToolCall): string {
  const base = TOOL_LABELS[call.name] ?? call.name
  if (call.name === 'ask_user' && typeof call.input === 'object' && call.input !== null) {
    const q = (call.input as { question?: unknown }).question
    if (typeof q === 'string' && q.trim()) return `Asked: ${q.trim()}`
  }
  return base
}

/** The first page with objects added or changed by these effects. */
export function effectTarget(effects: readonly ToolEffect[]): ToolTarget | null {
  for (const e of effects) {
    const byPage = new Map<PageId, ObjectId[]>()
    for (const op of e.ops) {
      if (op.type !== 'addObjects' && op.type !== 'updateObjects') continue
      const ids = op.type === 'addObjects' ? op.objects.map((o) => o.id) : op.patches.map((p) => p.id)
      byPage.set(op.pageId, [...(byPage.get(op.pageId) ?? []), ...ids])
    }
    const first = byPage.entries().next()
    if (!first.done) return { notebookId: e.notebookId, pageId: first.value[0], ids: first.value[1] }
  }
  return null
}

const NOUNS: Record<string, [string, string]> = {
  shape: ['shape', 'shapes'], frame: ['frame', 'frames'], arrow: ['arrow', 'arrows'], text: ['text box', 'text boxes'],
  image: ['image', 'images'], ink: ['stroke', 'strokes'], group: ['group', 'groups'], page: ['page', 'pages'],
}
const counted = (n: number, key: string) => `${n} ${NOUNS[key]?.[n === 1 ? 0 : 1] ?? `${key}${n === 1 ? '' : 's'}`}`
const objects = (n: number) => `${n} object${n === 1 ? '' : 's'}`

/** "Added 6 shapes, 5 arrows, updated 2 objects" from what the tools changed; read-only tools by name. */
export function summarizeTools(rows: readonly ToolRow[]): string {
  const added = new Map<string, number>()
  let updated = 0, deleted = 0, pagesUpdated = 0, pagesDeleted = 0, meta = false
  const ops: Operation[] = rows.flatMap((r) => r.result?.effects.flatMap((e) => e.ops) ?? [])
  for (const op of ops) {
    if (op.type === 'addObjects') {
      for (const o of op.objects) {
        if (o.type === 'group') continue
        const key = o.type === 'shape' && o.kind === 'frame' ? 'frame' : o.type
        added.set(key, (added.get(key) ?? 0) + 1)
      }
    } else if (op.type === 'addPage') added.set('page', (added.get('page') ?? 0) + 1)
    else if (op.type === 'updateObjects') updated += op.patches.length
    else if (op.type === 'deleteObjects') deleted += op.ids.length
    else if (op.type === 'updatePage') pagesUpdated++
    else if (op.type === 'deletePage') pagesDeleted++
    else if (op.type === 'updateMeta') meta = true
  }
  const parts: string[] = []
  if (added.size) parts.push(`added ${[...added].map(([k, n]) => counted(n, k)).join(', ')}`)
  if (updated) parts.push(`updated ${objects(updated)}`)
  if (deleted) parts.push(`deleted ${objects(deleted)}`)
  if (pagesUpdated) parts.push(`updated ${counted(pagesUpdated, 'page')}`)
  if (pagesDeleted) parts.push(`deleted ${counted(pagesDeleted, 'page')}`)
  if (meta) parts.push('updated the notebook')
  // calls the turn ended before (stop, failure) never ran: don't name them as if they did
  const notRun = rows.filter((r) => !r.result && r.state === 'error').length
  if (!parts.length) parts.push(...new Set(rows.filter((r) => r.result || r.state === 'running').map((r) => r.label.charAt(0).toLowerCase() + r.label.slice(1))))
  const failed = rows.filter((r) => r.result?.isError).length
  if (failed) parts.push(`${failed} failed`)
  if (notRun) parts.push(`${notRun} ${notRun === 1 ? 'call' : 'calls'} not run`)
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function endState(turn: TurnInfo, input: TimelineInput): { state: TurnEndState; message: string } | null {
  const mine = turn.deviceId === input.deviceId
  switch (turn.status) {
    case 'failed': return { state: 'failed', message: turn.error || 'This turn failed.' }
    case 'partial': return { state: 'partial', message: `Stopped at the limit${input.maxSteps ? ` of ${input.maxSteps} steps` : ''}. The edits so far are kept.` }
    case 'cancelled': return { state: 'cancelled', message: 'Stopped.' }
    case 'awaiting_tools':
      if (input.activeTurnId === turn.id) return null
      return mine
        ? { state: 'interrupted', message: 'This turn was interrupted.' }
        : { state: 'remote', message: 'Running on another device.' }
    case 'running':
      return mine || input.activeTurnId === turn.id ? null : { state: 'remote', message: 'Running on another device.' }
    default: return null
  }
}

export function deriveTimeline(input: TimelineInput): TimelineRow[] {
  const turns = new Map(input.turns.map((t) => [t.id, t]))
  const results = new Map<string, ToolResult>()
  for (const i of input.items) if (i.kind === 'tool_result') results.set(i.payload.toolCallId, i.payload)

  const rows: TimelineRow[] = []
  let tools: ToolRow[] = []
  let turnId: string | null = null
  let turnHasUser = false
  const lastItem = input.items.at(-1)

  const flushTools = () => {
    if (!tools.length) return
    const running = tools.some((t) => t.state === 'running')
    rows.push({ kind: 'tools', id: `tools:${tools[0].id}`, summary: summarizeTools(tools), tools, running })
    tools = []
  }
  const endTurn = () => {
    flushTools()
    const turn = turnId ? turns.get(turnId) : undefined
    const end = turn && endState(turn, input)
    if (turn && end) rows.push({ kind: 'turn_end', id: `end:${turn.id}`, turn, ...end })
  }

  for (const item of input.items) {
    if (turns.get(item.turnId)?.status === 'reverted') continue
    if (item.kind === 'tool_result') continue
    if (item.turnId !== turnId) {
      endTurn()
      turnId = item.turnId
      turnHasUser = false
    }
    if (item.kind === 'tool_call') {
      const result = results.get(item.payload.toolCallId) ?? null
      const live = input.activeTurnId === item.turnId && input.phase !== 'idle'
      tools.push({
        id: item.id,
        call: item.payload,
        result,
        label: toolLabel(item.payload),
        state: result ? (result.isError ? 'error' : 'done') : live ? 'running' : 'error',
        target: result ? effectTarget(result.effects) : null,
      })
      continue
    }
    flushTools()
    if (item.kind === 'user') {
      rows.push({ kind: 'user', id: item.id, turnId: item.turnId, message: item.payload, local: item.id.startsWith('local:'), steer: turnHasUser })
      turnHasUser = true
    } else {
      const streaming = item === lastItem && input.phase === 'streaming' && item.turnId === input.activeTurnId
      rows.push({ kind: 'assistant', id: item.id, text: item.payload.text, streaming })
    }
  }
  endTurn()

  if (input.failure) rows.push({ kind: 'failure', id: 'failure', message: input.failure.message })
  if (input.phase !== 'idle') {
    const label = input.waiting ? 'Waiting for your answer' : input.phase === 'sending' ? 'Sending' : input.phase === 'tools' ? 'Working on the notebook' : 'Thinking'
    rows.push({ kind: 'working', id: 'working', since: input.startedAt, label })
  }
  return rows
}
