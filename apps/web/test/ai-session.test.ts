import { describe, expect, it, vi } from 'vitest'
import { readStepEvents, type TurnApi } from '../src/ai/api'
import type { RevertEffects } from '../src/ai/host'
import type { BaseHost } from '../src/ai/session'
import { AiSession } from '../src/ai/session'
import type {
  Environment, StepEvent, StepReq, ThreadDetailRes, ThreadItem, ThreadSummary, ToolCall, ToolEffect, ToolResult, TurnInfo, UserMessage,
} from '../src/ai/protocol'

const DEVICE = 'dev-a'
const env: Environment = { notebookId: 'nb', notebookTitle: 'N', pageId: 'p1', viewport: null, outline: '' }
const msg = (text: string): UserMessage => ({ text, attachments: [], context: [] })
const thread: ThreadSummary = { id: 't1', notebookId: 'nb', title: 'T', pinKey: null, settledAt: null, lastActivityAt: 1, createdAt: 1, status: 'idle' }
const turn = (p: Partial<TurnInfo> = {}): TurnInfo => ({
  id: 'u1', threadId: 't1', seq: 1, status: 'running', presetId: 'smart', deviceId: DEVICE, steps: 0, tokensIn: 0, tokensOut: 0,
  cachedTokens: 0, costUsd: 0, error: null, createdAt: 1, updatedAt: 1, ...p,
})
const call: ToolCall = { toolCallId: 'c1', name: 'create_shapes', input: {} }
const callItem = (turnId = 'u1', seq = 2): ThreadItem => ({ id: `i-${turnId}-call`, threadId: 't1', turnId, seq, kind: 'tool_call', payload: call, createdAt: 1 })
const result: ToolResult = { toolCallId: 'c1', output: { ok: true }, isError: false, effects: [] }

async function* events(...list: StepEvent[]): AsyncGenerator<StepEvent> { for (const e of list) yield e }

function setup(opts: { api?: Partial<TurnApi>; run?: (c: ToolCall, turnId: string) => Promise<ToolResult>; detail?: ThreadDetailRes; revert?: RevertEffects } = {}) {
  const o = opts.api ?? {}
  const api = {
    createThread: vi.fn<TurnApi['createThread']>(o.createThread ?? (async () => thread)),
    startTurn: vi.fn<TurnApi['startTurn']>(o.startTurn ?? (() => events())),
    step: vi.fn<TurnApi['step']>(o.step ?? (() => events())),
    continueTurn: vi.fn<TurnApi['continueTurn']>(o.continueTurn ?? (() => events())),
    cancel: vi.fn<TurnApi['cancel']>(o.cancel ?? (async (id) => turn({ id, status: 'cancelled' }))),
    revert: vi.fn<TurnApi['revert']>(o.revert ?? (async () => ({ thread, turns: [], items: [] }))),
    thread: vi.fn<TurnApi['thread']>(async () => { if (opts.detail) return opts.detail; throw new Error('offline') }),
  }
  const run = vi.fn(opts.run ?? (async () => result))
  const revertEffects = vi.fn<RevertEffects>(opts.revert ?? (async () => ({ reverted: 0, skipped: [] })))
  const session = new AiSession({
    api,
    host: {} as BaseHost,
    createRunner: () => ({ run }),
    revertEffects,
    environment: async () => env,
    deviceId: DEVICE,
    notebookId: 'nb',
    presetId: () => 'smart',
  }, thread)
  return { session, api, run, revertEffects }
}

const until = async (fn: () => boolean) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 0)) }

describe('SSE parser', () => {
  it('reads events split across chunks, with CRLF, comments and multi-line data', async () => {
    const chunks = [
      ': keep-alive\r\n\r\nevent: step\r\ndata: {"type":"text_',
      'delta","itemId":"a","delta":"Hi"}\r\n\r\ndata: {"type":"step_end",\ndata: "status":"done"}\n\n',
      'data: not json\n\ndata: {"type":"unknown"}\n\n',
    ]
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close() },
    })
    const out: StepEvent[] = []
    for await (const e of readStepEvents(body)) out.push(e)
    expect(out).toEqual([{ type: 'text_delta', itemId: 'a', delta: 'Hi' }, { type: 'step_end', status: 'done' }])
  })
})

describe('AiSession turn loop', () => {
  it('runs the tool calls of a step and posts their results with a fresh environment', async () => {
    const { session, api, run } = setup({
      api: {
        startTurn: () => events({ type: 'turn', turn: turn() }, { type: 'item', item: callItem() }, { type: 'step_end', status: 'tool_calls' }),
        step: () => events({ type: 'step_end', status: 'done' }),
      },
    })
    session.send(msg('draw'))
    expect(session.phase.value).toBe('sending')
    await until(() => !session.busy.value)
    expect(run).toHaveBeenCalledWith(call, 'u1')
    expect(api.step).toHaveBeenCalledTimes(1)
    expect(api.step.mock.calls[0][0]).toBe('u1')
    expect(api.step.mock.calls[0][1]).toEqual({ results: [result], environment: env })
  })

  it('sends a message typed while a turn runs with the next step', async () => {
    let release!: () => void
    const { session, api } = setup({
      run: () => new Promise((r) => { release = () => r(result) }),
      api: {
        startTurn: () => events({ type: 'turn', turn: turn() }, { type: 'item', item: callItem() }, { type: 'step_end', status: 'tool_calls' }),
        step: () => events({ type: 'step_end', status: 'done' }),
      },
    })
    session.send(msg('draw'))
    await until(() => session.phase.value === 'tools')
    session.send(msg('make it blue'))
    expect(session.queued.value).toHaveLength(1)
    release()
    await until(() => !session.busy.value)
    expect((api.step.mock.calls[0][1] as StepReq).steer).toEqual(msg('make it blue'))
    expect(session.queued.value).toEqual([])
    expect(api.startTurn).toHaveBeenCalledTimes(1)
  })

  it('cancel aborts the stream and cancels the turn on the server', async () => {
    const { session, api } = setup({
      api: {
        startTurn: (_id, _req, signal) => (async function* (): AsyncGenerator<StepEvent> {
          yield { type: 'turn', turn: turn() }
          await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
        })(),
      },
    })
    session.send(msg('long'))
    await until(() => session.activeTurnId.value === 'u1')
    await session.cancel()
    await until(() => !session.busy.value)
    expect(api.cancel).toHaveBeenCalledWith('u1')
    expect(api.step).not.toHaveBeenCalled()
    expect(session.turns.value[0].status).toBe('cancelled')
  })
})

describe('AiSession revert and ownership', () => {
  const eff = (id: string): ToolEffect => ({ notebookId: 'nb', ops: [{ type: 'deleteObjects', pageId: 'p1', ids: [id] }], inverse: [] })
  const user = (turnId: string, seq: number): ThreadItem => ({ id: `user-${turnId}`, threadId: 't1', turnId, seq, kind: 'user', payload: msg(turnId), createdAt: 1 })
  const res = (turnId: string, seq: number, effects: ToolEffect[]): ThreadItem => ({
    id: `res-${turnId}-${seq}`, threadId: 't1', turnId, seq, kind: 'tool_result', payload: { ...result, effects }, createdAt: 1,
  })

  it('reverts the effects of that turn and every later one, newest first, then rewinds on the server', async () => {
    const log: string[] = []
    const detail: ThreadDetailRes = {
      thread,
      turns: [turn({ id: 'a', seq: 1, status: 'done' }), turn({ id: 'b', seq: 2, status: 'done' }), turn({ id: 'c', seq: 3, status: 'done' })],
      items: [
        user('a', 1), res('a', 2, [eff('a1')]),
        user('b', 3), res('b', 4, [eff('b1'), eff('b2')]), res('b', 5, [eff('b3')]),
        user('c', 6), res('c', 7, [eff('c1')]),
      ],
    }
    const revert: RevertEffects = async (_h, effects) => { log.push(`effects:${effects.map((e) => e.ops[0].type === 'deleteObjects' && e.ops[0].ids[0]).join(',')}`); return { reverted: effects.length, skipped: [] } }
    const { session, api } = setup({ detail, revert })
    api.revert.mockImplementation(async (id: string) => { log.push(`post:${id}`); return { ...detail, turns: detail.turns.map((t) => (t.seq >= 2 ? { ...t, status: 'reverted' as const } : t)) } })
    await session.load()
    const out = await session.revertTo('user-b')
    expect(log).toEqual(['effects:c1,b3,b2,b1', 'post:b'])
    expect(out?.message).toEqual(msg('b'))
  })

  it('shows a turn that another device drives as read-only', async () => {
    const other = { thread, turns: [turn({ id: 'x', status: 'awaiting_tools', deviceId: 'dev-b' })], items: [user('x', 1), callItem('x', 2)] }
    const { session, api } = setup({ detail: other })
    await session.load()
    expect(session.readOnly.value).toBe(true)
    expect(session.canContinue(session.turns.value[0])).toBe(false)
    session.send(msg('hello'))
    expect(api.startTurn).not.toHaveBeenCalled()
    session.dispose()

    const mine = setup({ detail: { ...other, turns: [turn({ id: 'x', status: 'awaiting_tools' })] } })
    await mine.session.load()
    expect(mine.session.readOnly.value).toBe(false)
    expect(mine.session.canContinue(mine.session.turns.value[0])).toBe(true)
  })
})
