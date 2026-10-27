import type { CanvasObject } from '@folio/document'
import { describe, expect, it } from 'vitest'
import type { ThreadItem, ToolEffect, TurnInfo } from '../src/ai/protocol'
import { deriveTimeline } from '../src/ai/timeline'

const turn: TurnInfo = {
  id: 'u1', threadId: 't1', seq: 1, status: 'done', presetId: 'smart', deviceId: 'dev', steps: 2, tokensIn: 0, tokensOut: 0,
  cachedTokens: 0, costUsd: 0, error: null, createdAt: 1, updatedAt: 1,
}
const base = { threadId: 't1', turnId: 'u1', createdAt: 1 }
const obj = (id: string, type: 'shape' | 'arrow') => ({ id, type }) as CanvasObject
const added = (...objects: CanvasObject[]): ToolEffect => ({ notebookId: 'nb', ops: [{ type: 'addObjects', pageId: 'p1', objects }], inverse: [] })

describe('deriveTimeline', () => {
  it('folds consecutive tool calls into one summarised row that targets their objects', () => {
    const items: ThreadItem[] = [
      { ...base, id: 'm', seq: 1, kind: 'user', payload: { text: 'Draw a flow', attachments: [], context: [] } },
      { ...base, id: 'c1', seq: 2, kind: 'tool_call', payload: { toolCallId: 'k1', name: 'get_page', input: {} } },
      { ...base, id: 'c2', seq: 3, kind: 'tool_call', payload: { toolCallId: 'k2', name: 'draw_diagram', input: {} } },
      { ...base, id: 'r1', seq: 4, kind: 'tool_result', payload: { toolCallId: 'k1', output: {}, isError: false, effects: [] } },
      { ...base, id: 'r2', seq: 5, kind: 'tool_result', payload: { toolCallId: 'k2', output: {}, isError: false, effects: [added(obj('a', 'shape'), obj('b', 'shape'), obj('x', 'arrow'))] } },
      { ...base, id: 'a', seq: 6, kind: 'assistant', payload: { text: 'Done.' } },
    ]
    const rows = deriveTimeline({ items, turns: [turn], phase: 'idle', activeTurnId: null, startedAt: 0, deviceId: 'dev', failure: null })
    expect(rows.map((r) => r.kind)).toEqual(['user', 'tools', 'assistant'])
    const tools = rows[1]
    if (tools.kind !== 'tools') throw new Error('expected a tools row')
    expect(tools.summary).toBe('Added 2 shapes, 1 arrow')
    expect(tools.tools.map((t) => t.state)).toEqual(['done', 'done'])
    expect(tools.tools[1].target).toEqual({ notebookId: 'nb', pageId: 'p1', ids: ['a', 'b', 'x'] })
  })

  it('names only calls that ran, and offers revert on the first message of a turn only', () => {
    const items: ThreadItem[] = [
      { ...base, id: 'm', seq: 1, kind: 'user', payload: { text: 'Add pages', attachments: [], context: [] } },
      { ...base, id: 'c1', seq: 2, kind: 'tool_call', payload: { toolCallId: 'k1', name: 'add_page', input: {} } },
      { ...base, id: 'r1', seq: 3, kind: 'tool_result', payload: { toolCallId: 'k1', output: {}, isError: false, effects: [] } },
      { ...base, id: 's', seq: 4, kind: 'user', payload: { text: 'And one more', attachments: [], context: [] } },
      { ...base, id: 'c2', seq: 5, kind: 'tool_call', payload: { toolCallId: 'k2', name: 'delete_page', input: {} } },
    ]
    const rows = deriveTimeline({ items, turns: [{ ...turn, status: 'cancelled' }], phase: 'idle', activeTurnId: null, startedAt: 0, deviceId: 'dev', failure: null })
    expect(rows.flatMap((r) => (r.kind === 'user' ? [r.steer] : []))).toEqual([false, true])
    expect(rows.flatMap((r) => (r.kind === 'tools' ? [r.summary] : []))).toEqual(['Added a page', '1 call not run'])
  })
})
