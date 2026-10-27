import { MemoryStorage } from '@folio/persistence'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { AiApi } from '../src/ai/api'
import { AI_DOCK_KEY, AiDock } from '../src/ai/dock'
import type { AiConfigRes, ContextChip, Instructions } from '../src/ai/protocol'
import { contextBuilder, createToolRunner, revertEffects } from '../src/ai/tools'
import { createServices, services } from '../src/app'
import AiComposer from '../src/components/ai/AiComposer.vue'
import InstructionsField from '../src/components/InstructionsField.vue'
import { NOTEBOOK_KEY, NotebookController } from '../src/notebook'
import { runtimeConfig } from '../src/services/runtime-config'
import { promptNoteBody } from '../src/services/prompt-notes'

describe('prompt note prefix', () => {
  it('reads @ai, @ ai and @AI: variants and returns the request without the prefix', () => {
    expect(promptNoteBody('@ai summarize this page')).toBe('summarize this page')
    expect(promptNoteBody('@AI: what is an eigenvector?')).toBe('what is an eigenvector?')
    expect(promptNoteBody('  @ ai - draw this as a flowchart')).toBe('draw this as a flowchart')
    expect(promptNoteBody('@Ai, list the dates')).toBe('list the dates')
    for (const no of ['@aim higher', 'call @ai later', '@ai', '@AI:  ', 'ai: no at sign']) expect(promptNoteBody(no)).toBeNull()
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
