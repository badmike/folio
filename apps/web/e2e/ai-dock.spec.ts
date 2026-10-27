import { expect, test, type Page, type Route } from '@playwright/test'
import type {
  AiConfigRes, StartTurnReq, StepEvent, StepReq, ThreadDetailRes, ThreadItem, ThreadSummary, ToolCall, TurnInfo,
} from '../src/ai/protocol'
import { newNotebook, objectsOf } from './helpers'

/** The AI dock against a scripted server: `/api/ai/*` answered with page.route and canned SSE. */

// page.route doesn't see requests a service worker answers
test.use({ serviceWorkers: 'block' })

const thread: ThreadSummary = {
  id: 't1', notebookId: null, title: 'New thread', pinKey: null, settledAt: null, lastActivityAt: 1, createdAt: 1, status: 'idle',
}
const config: AiConfigRes = {
  presets: [{ id: 'fast', label: 'Fast', hint: 'Quick edits and answers', vision: true }],
  defaultPresetId: 'fast',
  credit: { limitUsd: 1, usedUsd: 0.25, resetsAt: 0 },
  limits: { maxSteps: 25, maxTokensPerTurn: 2_000_000 },
}
const call: ToolCall = {
  toolCallId: 'c1', name: 'create_shapes', input: { shapes: [{ kind: 'rectangle', width: 200, height: 100, label: 'Hello' }] },
}

/** The kind and payload of a transcript item, kept paired. */
type Entry = ThreadItem extends infer I ? (I extends ThreadItem ? Pick<I, 'kind' | 'payload'> : never) : never

const sse = (route: Route, events: StepEvent[]) =>
  route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') })

/** One thread whose single turn calls create_shapes, then answers in text. Records what the client posts. */
async function scriptedServer(page: Page) {
  let turn: TurnInfo = {
    id: 'u1', threadId: 't1', seq: 1, status: 'running', presetId: 'fast', deviceId: '', steps: 0, tokensIn: 0, tokensOut: 0,
    cachedTokens: 0, costUsd: 0, error: null, createdAt: 1, updatedAt: 1,
  }
  let items: ThreadItem[] = []
  const posted: { start?: StartTurnReq; step?: StepReq; reverted: boolean } = { reverted: false }
  const item = (seq: number, entry: Entry): ThreadItem => ({ id: `i${seq}`, threadId: 't1', turnId: 'u1', seq, createdAt: 1, ...entry })
  const detail = (): ThreadDetailRes => ({ thread, turns: [turn], items })

  await page.route('**/config.json', (r) => r.fulfill({ json: { apiBase: '/api', clerkPublishableKey: '' } }))
  // sync and device registration aren't part of this test
  await page.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'not_found', message: 'not scripted' } }))
  await page.route('**/api/ai/config', (r) => r.fulfill({ json: config }))
  await page.route('**/api/ai/threads', (r) => r.fulfill({ json: thread }))
  await page.route('**/api/ai/threads/t1', (r) => r.fulfill({ json: detail() }))
  await page.route('**/api/ai/threads/t1/turns', (r) => {
    const req: StartTurnReq = r.request().postDataJSON()
    posted.start = req
    turn = { ...turn, deviceId: req.deviceId }
    items = [item(1, { kind: 'user', payload: req.message }), item(2, { kind: 'tool_call', payload: call })]
    return sse(r, [
      { type: 'turn', turn, userItem: items[0] },
      { type: 'item', item: items[1] },
      { type: 'turn', turn: (turn = { ...turn, status: 'awaiting_tools', steps: 1 }) },
      { type: 'step_end', status: 'tool_calls' },
    ])
  })
  await page.route('**/api/ai/turns/u1/step', (r) => {
    const req: StepReq = r.request().postDataJSON()
    posted.step = req
    const result = item(3, { kind: 'tool_result', payload: req.results[0] })
    const answer = item(4, { kind: 'assistant', payload: { text: 'I added a box labelled **Hello**.' } })
    items = [...items, result, answer]
    turn = { ...turn, status: 'done', steps: 2, costUsd: 0.01 }
    return sse(r, [
      { type: 'turn', turn: { ...turn, status: 'running' } },
      { type: 'item', item: result },
      { type: 'text_delta', itemId: answer.id, delta: 'I added a box ' },
      { type: 'text_delta', itemId: answer.id, delta: 'labelled **Hello**.' },
      { type: 'item', item: answer },
      { type: 'usage', turn, credit: { ...config.credit, usedUsd: 0.26 } },
      { type: 'turn', turn },
      { type: 'step_end', status: 'done' },
    ])
  })
  await page.route('**/api/ai/turns/u1/revert', (r) => {
    posted.reverted = true
    turn = { ...turn, status: 'reverted' }
    return r.fulfill({ json: detail() })
  })
  return posted
}

test('the dock runs a scripted tool call on the canvas and reverts it', async ({ page }) => {
  const posted = await scriptedServer(page)
  await page.addInitScript(() => localStorage.setItem('folio.devToken', 'dev:e2e'))
  await newNotebook(page, 'AI dock')

  await page.getByTestId('open-ai').click()
  const dock = page.getByTestId('ai-dock')
  await expect(dock.getByTestId('ai-empty')).toBeVisible()
  await expect(dock.getByTestId('ai-composer')).toContainText('$0.75 left')

  await dock.getByTestId('ai-input').fill('Draw a box that says Hello')
  await dock.getByTestId('ai-input').press('Enter')

  await expect(dock.getByTestId('ai-assistant-message')).toHaveText('I added a box labelled Hello.')
  await expect(dock.getByTestId('ai-tools')).toContainText('Added 1 shape')
  await expect(dock.getByTestId('ai-composer')).toContainText('$0.74 left')
  const shapes = await objectsOf(page, 'shape')
  expect(shapes.map((s) => s.label)).toEqual(['Hello'])

  // the step carried the result, with effects that undo it
  expect(posted.step?.deviceId).toBe(posted.start?.deviceId)
  const [result] = posted.step?.results ?? []
  expect(result).toMatchObject({ toolCallId: 'c1', isError: false, output: { ids: [shapes[0].id] } })
  expect(result.effects[0].ops[0]).toMatchObject({ type: 'addObjects' })
  expect(result.effects[0].inverse).toEqual([{ type: 'deleteObjects', pageId: expect.any(String), ids: [shapes[0].id] }])

  await dock.getByTestId('ai-revert').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Revert' }).click()
  await expect.poll(() => objectsOf(page, 'shape')).toHaveLength(0)
  expect(posted.reverted).toBe(true)
  await expect(dock.getByTestId('ai-empty')).toBeVisible()
  await expect(dock.getByTestId('ai-input')).toHaveValue('Draw a box that says Hello')
})
