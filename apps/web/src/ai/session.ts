/**
 * Turn loop driver for one AI thread. The server streams one model step per request; when a step ends
 * with tool calls, this device runs them (one by one, through the tool runner) and posts the results,
 * which starts the next step. Holds the thread's transcript as reactive state for the dock.
 */
import type { NotebookId } from '@folio/document'
import { computed, ref, shallowRef } from 'vue'
import { diagnostics } from '../services/diagnostics'
import { toast } from '../services/toast'
import { AiApiError, type TurnApi } from './api'
import type {
  ApprovalDecision, ApprovalRequest, AskUserAnswer, AskUserInput, CreateToolRunner, RevertEffects, RevertReport, ToolHost, ToolRunner,
} from './host'
import type {
  AiCredit, Environment, StepEvent, ThreadDetailRes, ThreadItem, ThreadSummary, ToolCall, ToolEffect, ToolResult, TurnInfo, TurnStatus, UserMessage,
} from './protocol'

/** The app's ToolHost without the two prompts, which each session answers in its own composer slot. */
export type BaseHost = Omit<ToolHost, 'approve' | 'ask'>

export type PendingRequest =
  | { kind: 'approval'; req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }
  | { kind: 'ask'; input: AskUserInput; resolve: (a: AskUserAnswer) => void }

/** sending: optimistic, before the server answered. streaming: a model step. tools: running tool calls. */
export type Phase = 'idle' | 'sending' | 'streaming' | 'tools'

export interface SessionDeps {
  api: TurnApi
  host: BaseHost
  createRunner: CreateToolRunner
  revertEffects: RevertEffects
  environment: (host: ToolHost) => Promise<Environment>
  deviceId: string
  notebookId: NotebookId | null
  presetId: () => string
  onCredit?: (credit: AiCredit) => void
  onThread?: (thread: ThreadSummary) => void
}

/** Turns that still change: this device may drive them, any other device only watches. */
const ACTIVE: readonly TurnStatus[] = ['running', 'awaiting_tools']
const REMOTE_POLL_MS = 4000

/** Items created on this device before the server knows them. */
export const isLocalItem = (i: ThreadItem): boolean => i.id.startsWith('local:')

/** The kind and payload of a transcript item, kept paired. */
type ItemEntry = ThreadItem extends infer I ? (I extends ThreadItem ? Pick<I, 'kind' | 'payload'> : never) : never

let sessionSeq = 0

export class AiSession {
  /** Stable identity for the UI (a draft's id appears only after its first message). */
  readonly key = ++sessionSeq
  /** null while the thread is a draft (created on the first message). */
  readonly thread = shallowRef<ThreadSummary | null>(null)
  /** Prompt note that starts this thread, sent with its creation. */
  sourceNote: string | undefined
  readonly turns = shallowRef<TurnInfo[]>([])
  readonly items = shallowRef<ThreadItem[]>([])
  readonly phase = ref<Phase>('idle')
  /** The turn this device drives right now. */
  readonly activeTurnId = ref<string | null>(null)
  /** When the current turn started on this device (the working row's timer). */
  readonly startedAt = ref(0)
  /** Messages typed while a turn runs; they go with the next step (steering). */
  readonly queued = shallowRef<UserMessage[]>([])
  readonly pending = shallowRef<PendingRequest | null>(null)
  /** A failure before the server created a turn; `retry` resends the message. */
  readonly failure = shallowRef<{ message: string; retry: UserMessage } | null>(null)
  readonly loading = ref(false)

  readonly busy = computed(() => this.phase.value !== 'idle')
  readonly latestTurn = computed(() => this.turns.value.filter((t) => t.status !== 'reverted').at(-1) ?? null)
  /** The latest turn is active on another device: this one only watches. */
  readonly readOnly = computed(() => {
    const t = this.latestTurn.value
    return !!t && ACTIVE.includes(t.status) && t.deviceId !== this.deps.deviceId && !this.busy.value
  })

  private readonly runner: ToolRunner
  /** The app host with this thread's approval and ask_user slot. */
  readonly host: ToolHost
  private abort: AbortController | null = null
  private cancelled = false
  private stepCalls: ToolCall[] = []
  private localSeq = 0
  /** "Allow for this thread" was given for writes to other notebooks. */
  private otherNotebooksAllowed = false
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  /** Only the latest refresh applies; an older answer may describe a turn that has moved on. */
  private refreshSeq = 0

  constructor(private readonly deps: SessionDeps, thread: ThreadSummary | null = null) {
    this.thread.value = thread
    this.host = { ...deps.host, approve: (req) => this.approve(req), ask: (input) => this.ask(input) }
    this.runner = deps.createRunner(this.host)
  }

  get id(): string | null { return this.thread.value?.id ?? null }

  /** Whether `turn` was started here and stopped mid-tools (tab closed): this device can continue it. */
  canContinue(turn: TurnInfo): boolean {
    return turn.status === 'awaiting_tools' && turn.deviceId === this.deps.deviceId && this.activeTurnId.value !== turn.id && !this.busy.value
  }

  async load(): Promise<void> {
    const id = this.id
    if (!id) return
    this.loading.value = true
    try { this.applyDetail(await this.deps.api.thread(id)) } finally { this.loading.value = false }
  }

  /** Send a message: starts a turn, or queues it as steering while one runs. */
  send(message: UserMessage): void {
    if (this.readOnly.value) return
    if (this.busy.value) {
      this.queued.value = [...this.queued.value, message]
      return
    }
    void this.runTurn(message)
  }

  /** Stop the running turn. Returns the queued messages' text so the composer can restore it. */
  async cancel(): Promise<string> {
    const queuedText = this.queued.value.map((m) => m.text).filter(Boolean).join('\n\n')
    this.queued.value = []
    this.cancelled = true
    this.abort?.abort()
    this.settlePending()
    const turnId = this.activeTurnId.value
    if (turnId) {
      try { this.upsertTurn(await this.deps.api.cancel(turnId)) } catch { /* the server ends it anyway */ }
      // the server answers once the turn settled: show its partial text and how it ended
      await this.refresh()
    }
    return queuedText
  }

  /** Answer the lost tool calls of an interrupted turn and run its next step. */
  async continueTurn(turn: TurnInfo): Promise<void> {
    if (!this.canContinue(turn)) return
    this.cancelled = false
    const environment = await this.deps.environment(this.host)
    await this.drive(turn.id, (signal) => this.deps.api.continueTurn(turn.id, { deviceId: this.deps.deviceId, environment }, signal))
  }

  /** Resend a failed turn's message as a new turn. */
  retry(turnId: string | null): void {
    if (this.busy.value) return
    if (turnId === null) {
      const f = this.failure.value
      if (f) void this.runTurn(f.retry)
      return
    }
    const user = this.items.value.find((i) => i.turnId === turnId && i.kind === 'user')
    if (user?.kind === 'user') void this.runTurn(user.payload)
  }

  /**
   * Undo the AI's edits of the turn holding `userItemId` and every later turn (newest first), then rewind
   * the conversation to before that message. Returns the message so the composer can offer it again.
   */
  async revertTo(userItemId: string): Promise<{ message: UserMessage; report: RevertReport } | null> {
    if (this.busy.value) return null
    const item = this.items.value.find((i) => i.id === userItemId)
    const turn = item && this.turns.value.find((t) => t.id === item.turnId)
    if (item?.kind !== 'user' || !turn) return null
    const report = await this.deps.revertEffects(this.host, this.effectsFrom(turn.seq))
    this.applyDetail(await this.deps.api.revert(turn.id))
    if (report.skipped.length) {
      const n = report.skipped.length
      toast(`${n} object${n === 1 ? '' : 's'} you changed after the AI did ${n === 1 ? 'was' : 'were'} left as ${n === 1 ? 'it is' : 'they are'}.`)
    }
    return { message: item.payload, report }
  }

  /** Effects of the turn with `seq` and every later live turn, newest first. */
  effectsFrom(seq: number): ToolEffect[] {
    const turns = new Set(this.turns.value.filter((t) => t.seq >= seq && t.status !== 'reverted').map((t) => t.id))
    return this.items.value
      .filter((i): i is Extract<ThreadItem, { kind: 'tool_result' }> => i.kind === 'tool_result' && turns.has(i.turnId))
      .sort((a, b) => b.seq - a.seq)
      .flatMap((i) => [...i.payload.effects].reverse())
  }

  answer(value: ApprovalDecision | AskUserAnswer): void {
    const p = this.pending.value
    if (!p) return
    this.pending.value = null
    if (p.kind === 'approval' && typeof value === 'string') p.resolve(value)
    else if (p.kind === 'ask' && typeof value === 'object') p.resolve(value)
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.pollTimer)
    this.abort?.abort()
    this.settlePending()
  }

  // ---- the loop -----------------------------------------------------------------

  private async runTurn(message: UserMessage): Promise<void> {
    // a message that failed before reaching the server is replaced by this one (or its retry)
    if (this.failure.value) this.items.value = this.items.value.filter((i) => !isLocalItem(i))
    this.failure.value = null
    this.cancelled = false
    this.phase.value = 'sending'
    this.startedAt.value = Date.now()
    this.addLocalUser(message, '')
    let started = false
    try {
      if (!this.thread.value) {
        this.thread.value = await this.deps.api.createThread({ notebookId: this.deps.notebookId, sourceNote: this.sourceNote })
        this.deps.onThread?.(this.thread.value)
      }
      const threadId = this.thread.value.id
      const environment = await this.deps.environment(this.host)
      if (this.cancelled) return this.dropLocal()
      started = true
      await this.drive(null, (signal) => this.deps.api.startTurn(threadId, {
        message, presetId: this.deps.presetId(), deviceId: this.deps.deviceId, environment,
      }, signal))
    } catch (e) {
      if (!started) this.failBeforeTurn(e, message)
    }
  }

  /** Stream a step, run its tool calls, post the results, repeat until the turn ends. */
  private async drive(turnId: string | null, first: (signal: AbortSignal) => AsyncIterable<StepEvent>): Promise<void> {
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.activeTurnId.value = turnId
    if (this.phase.value === 'idle') {
      this.phase.value = 'streaming'
      this.startedAt.value = Date.now()
    }
    try {
      let status = await this.consume(first(signal))
      while (status === 'tool_calls' && !this.cancelled) {
        const id = this.activeTurnId.value
        if (!id) throw new AiApiError(null, null, 'The server did not say which turn this is.')
        this.phase.value = 'tools'
        const results: ToolResult[] = []
        for (const call of this.stepCalls) {
          if (this.cancelled) break
          const result = await this.runner.run(call, id)
          results.push(result)
          this.addLocal(id, { kind: 'tool_result', payload: result })
        }
        if (this.cancelled) {
          // the tools that ran keep their undo records, without a next step
          if (results.length) await this.deps.api.postResults(id, { deviceId: this.deps.deviceId, results })
          return
        }
        const environment = await this.deps.environment(this.host)
        const steer = this.takeQueued()
        if (steer) this.addLocalUser(steer, id)
        this.phase.value = 'streaming'
        status = await this.consume(this.deps.api.step(id, { deviceId: this.deps.deviceId, results, environment, ...(steer ? { steer } : {}) }, signal))
      }
    } catch (e) {
      if (!this.cancelled && !(e instanceof DOMException && e.name === 'AbortError')) this.failTurn(e)
    } finally {
      this.abort = null
      this.activeTurnId.value = null
      this.phase.value = 'idle'
      this.settlePending()
      await this.refresh()
      const next = this.cancelled ? null : this.takeQueued()
      if (next && !this.disposed) void this.runTurn(next)
    }
  }

  /** Apply one step's events; returns how the step ended. */
  private async consume(events: AsyncIterable<StepEvent>): Promise<'tool_calls' | TurnStatus> {
    this.stepCalls = []
    for await (const ev of events) {
      switch (ev.type) {
        case 'turn':
          this.upsertTurn(ev.turn)
          this.activeTurnId.value = ev.turn.id
          if (ev.userItem) this.reconcileUser(ev.userItem)
          if (this.phase.value === 'sending') this.phase.value = 'streaming'
          break
        case 'text_delta':
          this.appendText(ev.itemId, ev.delta)
          break
        case 'item':
          if (ev.item.kind === 'user') this.reconcileUser(ev.item)
          else this.upsertItem(ev.item)
          if (ev.item.kind === 'tool_call') this.stepCalls.push(ev.item.payload)
          break
        case 'usage':
          this.upsertTurn(ev.turn)
          this.deps.onCredit?.(ev.credit)
          break
        case 'thread':
          this.thread.value = ev.thread
          this.deps.onThread?.(ev.thread)
          break
        case 'error':
          throw new AiApiError(ev.code, null, ev.message)
        case 'step_end':
          return ev.status
      }
    }
    throw new AiApiError(null, null, 'The connection to the server was lost.')
  }

  private takeQueued(): UserMessage | null {
    const q = this.queued.value
    if (!q.length) return null
    this.queued.value = []
    if (q.length === 1) return q[0]
    return {
      text: q.map((m) => m.text).filter(Boolean).join('\n\n'),
      attachments: q.flatMap((m) => m.attachments),
      context: q.flatMap((m) => m.context),
    }
  }

  private approve(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (req.kind === 'other_notebook' && this.otherNotebooksAllowed) return Promise.resolve('thread')
    return new Promise((resolve) => {
      this.pending.value = {
        kind: 'approval', req, resolve: (d) => {
          if (d === 'thread' && req.kind === 'other_notebook') this.otherNotebooksAllowed = true
          resolve(d)
        },
      }
    })
  }

  private ask(input: AskUserInput): Promise<AskUserAnswer> {
    return new Promise((resolve) => { this.pending.value = { kind: 'ask', input, resolve } })
  }

  /** Nobody can answer any more (cancel, failure): deny or dismiss, so the tool returns. */
  private settlePending(): void {
    const p = this.pending.value
    if (!p) return
    this.pending.value = null
    if (p.kind === 'approval') p.resolve('deny')
    else p.resolve({ dismissed: true })
  }

  /** The message stays in the timeline, with the error and Retry below it. */
  private failBeforeTurn(e: unknown, message: UserMessage): void {
    this.phase.value = 'idle'
    this.failure.value = { message: errorMessage(e), retry: message }
  }

  private dropLocal(): void {
    this.phase.value = 'idle'
    this.items.value = this.items.value.filter((i) => !isLocalItem(i))
  }

  private failTurn(e: unknown): void {
    const id = this.activeTurnId.value
    const turn = id ? this.turns.value.find((t) => t.id === id) : undefined
    if (turn) this.upsertTurn({ ...turn, status: 'failed', error: errorMessage(e) })
    else this.failure.value = { message: errorMessage(e), retry: this.lastLocalUser() ?? { text: '', attachments: [], context: [] } }
  }

  /** Reload the server's view of the thread; keeps the local one when that fails. */
  private async refresh(): Promise<void> {
    const id = this.id
    if (!id || this.disposed) return
    const seq = ++this.refreshSeq
    try {
      const detail = await this.deps.api.thread(id)
      if (seq !== this.refreshSeq) return
      // a failure the server never recorded (connection lost) stays visible
      const failed = this.turns.value.filter((t) => t.status === 'failed')
      this.applyDetail(detail)
      for (const f of failed) {
        const t = this.turns.value.find((x) => x.id === f.id)
        if (t && ACTIVE.includes(t.status) && t.deviceId === this.deps.deviceId) this.upsertTurn({ ...t, status: 'failed', error: f.error })
      }
    } catch { /* offline: keep what we have */ }
  }

  private applyDetail(d: ThreadDetailRes): void {
    const unsent = this.failure.value ? this.items.value.filter((i) => isLocalItem(i) && i.kind === 'user') : []
    this.thread.value = d.thread
    this.turns.value = [...d.turns].sort((a, b) => a.seq - b.seq)
    this.items.value = [...[...d.items].sort((a, b) => a.seq - b.seq), ...unsent]
    this.schedulePoll()
  }

  /** Follow a turn another device drives. */
  private schedulePoll(): void {
    clearTimeout(this.pollTimer)
    if (this.disposed || !this.readOnly.value) return
    this.pollTimer = setTimeout(() => void this.refresh(), REMOTE_POLL_MS)
  }

  // ---- transcript edits -----------------------------------------------------------

  private nextSeq(): number { return (this.items.value.at(-1)?.seq ?? 0) + 0.5 }

  private addLocalUser(message: UserMessage, turnId: string): void { this.addLocal(turnId, { kind: 'user', payload: message }) }

  /** Shown until the server echoes its copy in the next step stream. */
  private addLocal(turnId: string, entry: ItemEntry): void {
    const item: ThreadItem = { id: `local:${++this.localSeq}`, threadId: this.id ?? '', turnId, seq: this.nextSeq(), createdAt: Date.now(), ...entry }
    this.items.value = [...this.items.value, item]
  }

  private lastLocalUser(): UserMessage | null {
    const i = [...this.items.value].reverse().find((x) => isLocalItem(x) && x.kind === 'user')
    return i?.kind === 'user' ? i.payload : null
  }

  /** The server's copy of a user message replaces the oldest optimistic one. */
  private reconcileUser(item: ThreadItem): void {
    const local = this.items.value.find((i) => isLocalItem(i) && i.kind === 'user')
    const rest = local ? this.items.value.filter((i) => i !== local) : this.items.value
    this.items.value = insertSorted(rest.filter((i) => i.id !== item.id), item)
  }

  /** A server tool result also replaces the optimistic one for the same call. */
  private upsertItem(item: ThreadItem): void {
    const callId = item.kind === 'tool_result' ? item.payload.toolCallId : null
    const keep = (i: ThreadItem) => i.id !== item.id && !(callId && isLocalItem(i) && i.kind === 'tool_result' && i.payload.toolCallId === callId)
    this.items.value = insertSorted(this.items.value.filter(keep), item)
  }

  private appendText(itemId: string, delta: string): void {
    const list = this.items.value
    const idx = list.findIndex((i) => i.id === itemId)
    const cur = list[idx]
    if (cur?.kind === 'assistant') {
      const next = list.slice()
      next[idx] = { ...cur, payload: { text: cur.payload.text + delta } }
      this.items.value = next
      return
    }
    this.items.value = [...list, {
      id: itemId, threadId: this.id ?? '', turnId: this.activeTurnId.value ?? '', seq: this.nextSeq(), kind: 'assistant',
      payload: { text: delta }, createdAt: Date.now(),
    }]
  }

  private upsertTurn(turn: TurnInfo): void {
    const rest = this.turns.value.filter((t) => t.id !== turn.id)
    this.turns.value = [...rest, turn].sort((a, b) => a.seq - b.seq)
  }
}

function insertSorted(list: ThreadItem[], item: ThreadItem): ThreadItem[] {
  const i = list.findIndex((x) => x.seq > item.seq)
  return i < 0 ? [...list, item] : [...list.slice(0, i), item, ...list.slice(i)]
}

function errorMessage(e: unknown): string {
  if (e instanceof AiApiError) return e.message
  diagnostics.log('ai.turn', e)
  return 'Something went wrong.'
}
