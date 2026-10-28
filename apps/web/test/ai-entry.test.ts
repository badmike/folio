import { NotebookDocument, encodeInkPoints, identityTransform, type InkStroke, type Recognition } from '@folio/document'
import { MemoryStorage } from '@folio/persistence'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { AiApi } from '../src/ai/api'
import { AI_DOCK_KEY, AiDock } from '../src/ai/dock'
import type { AiConfigRes, ContextChip, Instructions, ThreadSummary, UserMessage } from '../src/ai/protocol'
import { contextBuilder, createToolRunner, revertEffects } from '../src/ai/tools'
import { createServices, services } from '../src/app'
import AiComposer from '../src/components/ai/AiComposer.vue'
import InstructionsField from '../src/components/InstructionsField.vue'
import { NOTEBOOK_KEY, NotebookController } from '../src/notebook'
import { runtimeConfig } from '../src/services/runtime-config'
import { findPromptNotes, promptNoteBody } from '../src/services/prompt-notes'

describe('prompt note prefix', () => {
  it('reads @ai, @ ai and @AI: variants and returns the request without the prefix', () => {
    expect(promptNoteBody('@ai summarize this page')).toBe('summarize this page')
    expect(promptNoteBody('@AI: what is an eigenvector?')).toBe('what is an eigenvector?')
    expect(promptNoteBody('  @ ai - draw this as a flowchart')).toBe('draw this as a flowchart')
    expect(promptNoteBody('@Ai, list the dates')).toBe('list the dates')
    for (const no of ['@aim higher', 'call @ai later', '@ai', '@AI:  ', 'ai: no at sign']) expect(promptNoteBody(no)).toBeNull()
  })
})

describe('prompt note lines', () => {
  const stroke = (id: string): InkStroke => ({
    id, type: 'ink', transform: identityTransform(), z: 1, createdAt: 1, updatedAt: 1, points: encodeInkPoints([{ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, t: 0 }]),
    style: { tool: 'pen', color: '#000', width: 2, opacity: 1, pressureSensitive: false }, startedAt: 1, pointerType: 'pen',
  })
  const line = (id: string, y: number, text: string): Recognition => ({
    id: `r-${id}`, kind: 'text', strokeIds: [id], bounds: { x: 100, y, width: 200, height: 30 }, text, confidence: 0.9, recognizer: 't', createdAt: 1,
  })

  it('sends every handwritten line of a note, but not text further down', () => {
    const doc = NotebookDocument.create({ title: 'Notes' })
    const pageId = doc.pages()[0].id
    const lines = [line('a', 100, '@ai summarize'), line('b', 135, 'this page in'), line('c', 170, 'two sentences'), line('d', 600, 'shopping list')]
    doc.apply([
      { type: 'addObjects', pageId, objects: lines.map((l) => stroke(l.strokeIds[0])) },
      { type: 'setRecognitions', pageId, recognitions: lines },
    ])
    const [note, ...rest] = findPromptNotes(doc, pageId)
    expect(rest).toEqual([])
    expect(note.text).toBe('summarize\nthis page in\ntwo sentences')
    expect(note.strokeIds).toEqual(['a', 'b', 'c'])
    expect(note.key).toBe('a')
  })
})

describe('thread list in the dock', () => {
  const thread = (id: string, pinKey: string | null, sourceNote: string | null = null): ThreadSummary => ({
    id, notebookId: 'nb', title: id, pinKey, sourceNote, settledAt: null, lastActivityAt: 1, createdAt: 1, status: 'idle',
  })
  const setup = async (list: ThreadSummary[]) => {
    const patches: unknown[] = []
    const api = new AiApi({
      getToken: async () => 'token',
      fetch: async (_url, init) => {
        if (init?.method === 'PATCH') {
          const body: { pinKey: string } = JSON.parse(String(init.body))
          patches.push(body.pinKey)
          return new Response(JSON.stringify({ ...list[0], pinKey: body.pinKey }))
        }
        return new Response(JSON.stringify(list))
      },
    })
    const svc = await createServices(new MemoryStorage())
    const id = await svc.workspace.createNotebook({ title: 'Physics' })
    const ctl = new NotebookController(svc.workspace, await svc.workspace.openNotebook(id), svc.recognition)
    const auth = { signedIn: computed(() => true), online: ref(true) }
    const dock = new AiDock(api, svc.workspace, auth, ctl, { createToolRunner, revertEffects, contextBuilder })
    return { dock, patches }
  }
  const apiBase = runtimeConfig.apiBase
  afterEach(() => { runtimeConfig.apiBase = apiBase })

  it('links prompt notes to their threads, settled ones included', async () => {
    runtimeConfig.apiBase = 'http://folio.test'
    const { dock } = await setup([thread('t1', null, 'stroke-a'), thread('t2', null)])
    await dock.loadNoteThreads()
    expect([...dock.noteThreads.value]).toEqual([['stroke-a', 't1']])
    dock.dispose()
  })

  it('moves a pinned thread to a key between its new neighbours', async () => {
    runtimeConfig.apiBase = 'http://folio.test'
    const list = [thread('t1', 'a'), thread('t2', 'b'), thread('t3', 'c')]
    const { dock, patches } = await setup(list)
    dock.threads.value = list
    await dock.movePin(list[2], 1)
    expect(patches).toHaveLength(1)
    expect(typeof patches[0] === 'string' && patches[0] > 'a' && patches[0] < 'b').toBe(true)
    dock.dispose()
  })
})

describe('selection Ask AI', () => {
  const config: AiConfigRes = {
    presets: [{ id: 'smart', label: 'Smart', hint: '', vision: true }], defaultPresetId: 'smart',
    credit: { limitUsd: 1, usedUsd: 0, resetsAt: 0 }, limits: { maxSteps: 25, maxTokensPerTurn: 2_000_000 },
  }
  const apiBase = runtimeConfig.apiBase
  afterEach(() => { runtimeConfig.apiBase = apiBase })

  it('opens the dock and the composer shows the selection chip, focused', async () => {
    runtimeConfig.apiBase = 'http://folio.test'
    const svc = await createServices(new MemoryStorage())
    services.value = svc
    const ws = svc.workspace
    const id = await ws.createNotebook({ title: 'Physics' })
    const ctl = new NotebookController(ws, await ws.openNotebook(id), svc.recognition)
    const page = ctl.doc.pages()[0].id
    const chip: ContextChip = { kind: 'selection', label: '2 selected', ref: { notebookId: id, pageId: page, objectIds: ['b', 'a'] }, content: '' }
    const api = new AiApi({ getToken: async () => 'token', fetch: async () => new Response(JSON.stringify(config)) })
    const auth = { signedIn: computed(() => true), online: ref(true) }
    const dock = new AiDock(api, ws, auth, ctl, { createToolRunner, revertEffects, contextBuilder: { ...contextBuilder, selectionChip: async () => chip } })

    const w = mount(AiComposer, {
      props: { session: dock.session.value },
      global: { provide: { [AI_DOCK_KEY]: dock, [NOTEBOOK_KEY]: ctl }, stubs: { teleport: true } },
      attachTo: document.body,
    })
    await dock.askAboutSelection()
    await flushPromises()

    expect(dock.open.value).toBe(true)
    expect(w.findAll('[data-testid="ai-chip"]').map((c) => c.text())).toEqual(['2 selected'])
    expect(document.activeElement).toBe(w.get('[data-testid="ai-input"]').element)
    w.unmount()
    dock.dispose()
  })

  it('sends an image without text', async () => {
    const svc = await createServices(new MemoryStorage())
    services.value = svc
    const api = new AiApi({ getToken: async () => 'token', fetch: async () => new Response('{}') })
    const auth = { signedIn: computed(() => true), online: ref(true) }
    const dock = new AiDock(api, svc.workspace, auth, null, { createToolRunner, revertEffects, contextBuilder })
    const send = vi.spyOn(dock.session.value, 'send').mockImplementation(() => {})
    const w = mount(AiComposer, { props: { session: dock.session.value }, global: { provide: { [AI_DOCK_KEY]: dock }, stubs: { teleport: true } } })
    const sendButton = w.get('[data-testid="ai-send"]')
    expect(sendButton.attributes('disabled')).toBeDefined()

    const message: UserMessage = { text: '', attachments: ['asset1'], context: [] }
    w.getComponent(AiComposer).vm.restore(message)
    await flushPromises()
    await sendButton.trigger('click')

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '', attachments: ['asset1'] }))
    w.unmount()
    dock.dispose()
  })
})

describe('custom instructions', () => {
  it('loads, saves through the API and refuses text over 4000 characters', async () => {
    const api = {
      instructions: vi.fn(async (notebookId: string | null): Promise<Instructions> => ({ notebookId, text: 'Be brief.' })),
      saveInstructions: vi.fn(async (i: Instructions) => i),
    }
    const w = mount(InstructionsField, { props: { api, notebookId: 'nb1', label: 'This notebook', description: '', disabledReason: null } })
    await flushPromises()
    const input = w.get<HTMLTextAreaElement>('[data-testid="instructions-input"]')
    const save = w.get('[data-testid="instructions-save"]')
    expect(api.instructions).toHaveBeenCalledWith('nb1')
    expect(input.element.value).toBe('Be brief.')
    expect(input.attributes('maxlength')).toBe('4000')

    await input.setValue('x'.repeat(4001))
    expect(w.get('[data-testid="instructions-count"]').classes()).toContain('over')
    expect(save.attributes('disabled')).toBeDefined()
    await save.trigger('click')
    expect(api.saveInstructions).not.toHaveBeenCalled()

    await input.setValue('  Answer in German.  ')
    await save.trigger('click')
    await flushPromises()
    expect(api.saveInstructions).toHaveBeenCalledWith({ notebookId: 'nb1', text: 'Answer in German.' })
    expect(w.get('[data-testid="instructions-status"]').text()).toBe('Saved')
  })
})
