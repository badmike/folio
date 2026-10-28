/**
 * Wire contract between the web client and the folio-server AI gateway (AI V2).
 * The server mirrors these shapes with serde (`apps/server/src/agent/`). Change both sides together.
 *
 * Flow: the server owns prompts, tool schemas, history, budget and the model call. The client owns the
 * notebook, so it executes every tool call and posts the results back, which starts the next model step.
 *
 *   POST /ai/threads/{id}/turns   -> SSE (one model step)
 *   POST /ai/turns/{id}/step      -> SSE (next step, carries tool results and an optional steer message)
 *   repeat until `step_end.status` is not 'tool_calls'
 *
 * All JSON is camelCase. All ids are strings. Times are epoch milliseconds.
 */
import type { NotebookId, ObjectId, Operation, PageId, Rect } from '@folio/document'

// ---------------------------------------------------------------------------
// Config and budget
// ---------------------------------------------------------------------------

export interface AiPreset {
  id: string
  label: string
  /** One-line description for the picker, e.g. "Quick edits and answers". */
  hint: string
  vision: boolean
}

export interface AiCredit {
  limitUsd: number
  usedUsd: number
  /** When the daily credit resets (next UTC midnight). */
  resetsAt: number
}

/** GET /ai/config. 503 `ai_not_configured` when the server has no API key: hide the AI features. */
export interface AiConfigRes {
  presets: AiPreset[]
  defaultPresetId: string
  credit: AiCredit
  /** Per-turn caps, shown in the UI when a turn ends as 'partial'. */
  limits: { maxSteps: number; maxTokensPerTurn: number }
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/** Status is derived by the server from the latest turn, never stored on the thread. */
export type ThreadStatus = 'idle' | 'running' | 'awaiting_tools' | 'needs_input' | 'failed'

export interface ThreadSummary {
  id: string
  /** null for library threads. */
  notebookId: NotebookId | null
  title: string
  /** Fractional order key while pinned, null when not pinned. */
  pinKey: string | null
  /** Key of the prompt note that started the thread, null otherwise. */
  sourceNote: string | null
  settledAt: number | null
  lastActivityAt: number
  createdAt: number
  status: ThreadStatus
}

/** GET /ai/threads?notebookId=<id>|library&search=<q>&settled=0|1 (both when omitted) -> ThreadSummary[] (pinned first, then lastActivityAt desc) */
export type ThreadListRes = ThreadSummary[]

/** POST /ai/threads -> ThreadSummary. Title starts as "New thread" and is replaced by the auto title. */
export interface CreateThreadReq {
  notebookId: NotebookId | null
  /** Key of the prompt note this thread answers; the thread list returns it so every device shows the note as done. */
  sourceNote?: string
}

/** PATCH /ai/threads/{id} -> ThreadSummary. Renaming locks the title against auto titling. */
export interface UpdateThreadReq {
  title?: string
  /** A fractional key pins, null unpins. */
  pinKey?: string | null
  /** true settles, false unsettles. A new turn unsettles automatically. */
  settled?: boolean
}

/** DELETE /ai/threads/{id} -> 204. Never reverts notebook edits. */

export type TurnStatus =
  | 'running' // a model step is streaming
  | 'awaiting_tools' // the step ended with tool calls; the starting device must post results
  | 'done'
  | 'partial' // a cap was hit; edits so far are kept
  | 'failed'
  | 'cancelled'
  | 'reverted' // rewound by "Revert to this message"; hidden from history sent to the model

export interface TurnInfo {
  id: string
  threadId: string
  seq: number
  status: TurnStatus
  presetId: string
  /** Device that started the turn. Only that device executes its tools. */
  deviceId: string
  steps: number
  tokensIn: number
  tokensOut: number
  cachedTokens: number
  costUsd: number
  error: string | null
  createdAt: number
  updatedAt: number
}

/**
 * One transcript entry. The client derives every timeline row from these (T3 Code style), so new
 * tool kinds need no schema change. `seq` is monotonic per thread.
 */
export type ThreadItem =
  | ItemBase<'user', UserMessage>
  | ItemBase<'assistant', { text: string }>
  | ItemBase<'tool_call', ToolCall>
  | ItemBase<'tool_result', ToolResult>

interface ItemBase<K extends string, P> {
  id: string
  threadId: string
  turnId: string
  seq: number
  kind: K
  payload: P
  createdAt: number
}

/** GET /ai/threads/{id} */
export interface ThreadDetailRes {
  thread: ThreadSummary
  turns: TurnInfo[]
  items: ThreadItem[]
}

// ---------------------------------------------------------------------------
// Turns and steps
// ---------------------------------------------------------------------------

/**
 * Context the composer attaches. The client renders `content` (semantic text with object ids and
 * bounds); the server fences it as untrusted data and never interprets `ref`.
 */
export interface ContextChip {
  kind: 'page' | 'selection' | 'frame' | 'notebook' | 'prompt_note'
  label: string
  ref: { notebookId: NotebookId; pageId?: PageId; objectIds?: ObjectId[] }
  content: string
}

export interface UserMessage {
  text: string
  /** Asset ids from POST /assets. Images only; refused up front when the preset has no vision. */
  attachments: string[]
  context: ContextChip[]
  /** Slash command that produced this message, e.g. "summarize". Display only. */
  command?: string
}

/** Where the user is right now. Sent with every turn start and step; rendered into the user message. */
export interface Environment {
  notebookId: NotebookId | null
  notebookTitle: string | null
  pageId: PageId | null
  /** Visible world rect, so new content lands where the user looks. */
  viewport: Rect | null
  /** Outline of the current page (or of the notebook list in the library), rendered by the client. */
  outline: string
}

/** POST /ai/threads/{id}/turns -> text/event-stream of StepEvent. 409 `conflict` while another turn is running or awaiting tools. */
export interface StartTurnReq {
  message: UserMessage
  presetId: string
  deviceId: string
  environment: Environment
}

export interface ToolCall {
  toolCallId: string
  name: ToolName
  input: unknown
}

/** One notebook mutation made by a tool, with what undoes it. Opaque to the server; stored for revert. */
export interface ToolEffect {
  notebookId: NotebookId
  ops: Operation[]
  inverse: Operation[]
}

export interface ToolResult {
  toolCallId: string
  /** JSON sent to the model as the tool result. */
  output: unknown
  isError: boolean
  /** Base64 PNG for `look`; the server attaches it as an image for the model. */
  image?: string
  /** Stored, never sent to the model. */
  effects: ToolEffect[]
}

/** POST /ai/turns/{id}/step -> text/event-stream of StepEvent. Only the turn's device may call this. */
export interface StepReq {
  deviceId: string
  results: ToolResult[]
  environment: Environment
  /** A message typed while the turn ran; added after the tool results (steering). */
  steer?: UserMessage
}

/**
 * POST /ai/turns/{id}/results -> 204. Stores results for pending calls without running a step, so a turn
 * stopped while its tools ran ('awaiting_tools' or 'cancelled') keeps their effects. Only the turn's device may call this.
 */
export interface ResultsReq {
  deviceId: string
  results: ToolResult[]
}

/** POST /ai/turns/{id}/cancel -> TurnInfo */

/**
 * POST /ai/turns/{id}/revert -> ThreadDetailRes
 * Marks this turn and every later turn 'reverted'. The client undoes the notebook edits first,
 * using the stored `effects` of those turns, then calls this to rewind the conversation.
 */

/**
 * POST /ai/turns/{id}/continue -> text/event-stream of StepEvent
 * For an 'awaiting_tools' turn whose results were lost (tab closed). The server answers every pending
 * tool call with an "interrupted, re-read the notebook" error result and runs the next step.
 */
export interface ContinueReq {
  deviceId: string
  environment: Environment
}

export type StepEvent =
  | { type: 'turn'; turn: TurnInfo; userItem?: ThreadItem }
  | { type: 'text_delta'; itemId: string; delta: string }
  /** A complete item as persisted: assistant text, tool calls, and tool results (posted or synthesised by continue). */
  | { type: 'item'; item: ThreadItem }
  | { type: 'usage'; turn: TurnInfo; credit: AiCredit }
  | { type: 'step_end'; status: 'tool_calls' | TurnStatus }
  | { type: 'thread'; thread: ThreadSummary }
  | { type: 'error'; code: AiErrorCode; message: string }

export type AiErrorCode =
  | 'ai_not_configured'
  | 'credit_exhausted'
  | 'not_turn_device'
  | 'turn_not_awaiting'
  | 'no_vision'
  | 'upstream'
  | 'bad_request'
  | 'conflict'

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

/** GET /ai/instructions?notebookId=<id> (omit for the user-level text) -> Instructions */
export interface Instructions { notebookId: NotebookId | null; text: string }
/** PUT /ai/instructions with Instructions -> Instructions. Max 4000 characters. Empty text deletes. */

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Every tool the model can call. Schemas, descriptions and the tool guide live in
 * `apps/server/tools/` (server-owned); the client executes them in `apps/web/src/ai/tools/`.
 */
export const TOOL_NAMES = [
  // read
  'list_pages', 'get_page', 'read_objects', 'look', 'search_notebooks', 'read_notebook',
  // write
  'create_shapes', 'create_text', 'connect', 'update_objects', 'move_objects', 'delete_objects',
  'group_objects', 'draw_diagram', 'insert_image', 'add_page', 'update_page', 'delete_page', 'update_notebook',
  // interaction
  'ask_user',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]
