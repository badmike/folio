import type { FolderEntry } from '@folio/document'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import DialogHost from '../src/components/DialogHost.vue'
import FolderTree from '../src/components/FolderTree.vue'
import Menu from '../src/components/Menu.vue'
import NewNotebookDialog from '../src/components/NewNotebookDialog.vue'
import { chooseDialog, closeDialog, confirmDialog, dialog, promptDialog } from '../src/services/dialogs'

const teleportStub = { global: { stubs: { teleport: true } } }
afterEach(() => { while (dialog.value) closeDialog() })

const folder = (id: string, name: string, parentId: string | null = null): FolderEntry => ({ id, name, parentId, createdAt: 1, updatedAt: 1 })

describe('NewNotebookDialog', () => {
  it('emits the chosen page type, pattern and title', async () => {
    const w = mount(NewNotebookDialog, teleportStub)
    await w.get('[data-testid="new-title"]').setValue('Physics')
    await w.get('[data-testid="type-A4"]').trigger('click')
    const grid = w.findAll('button').find((b) => b.text() === 'Grid')!
    await grid.trigger('click')
    await w.get('form').trigger('submit')
    expect(w.emitted('create')![0][0]).toEqual({ title: 'Physics', pageType: 'A4', pattern: 'grid' })
  })

  it('closes on Cancel', async () => {
    const w = mount(NewNotebookDialog, teleportStub)
    await w.findAll('button').find((b) => b.text() === 'Cancel')!.trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })
})

describe('FolderTree', () => {
  const folders = [folder('a', 'Work'), folder('b', 'Projects', 'a'), folder('c', 'Home')]

  it('renders nested folders and counts, and emits selection', async () => {
    const w = mount(FolderTree, { props: { folders, selected: 'all', counts: { all: 5, a: 2, b: 1 } }, ...teleportStub })
    const rows = w.findAll('[data-testid="folder-row"]')
    expect(rows.map((r) => r.find('.name').text())).toEqual(['Work', 'Projects', 'Home'])
    expect(parseInt(rows[1].attributes('style')!.match(/padding-left: (\d+)/)![1])).toBeGreaterThan(parseInt(rows[0].attributes('style')!.match(/padding-left: (\d+)/)![1]))
    expect(w.text()).toContain('5')
    await rows[1].trigger('click')
    expect(w.emitted('select')![0]).toEqual(['b'])
  })

  it('emits drop with the notebook id when a card is dropped on a folder', async () => {
    const w = mount(FolderTree, { props: { folders, selected: 'all', counts: {} }, ...teleportStub })
    const row = w.findAll('[data-testid="folder-row"]')[2]
    await row.trigger('drop', { dataTransfer: { getData: () => 'nb1' } })
    expect(w.emitted('drop')![0]).toEqual(['c', 'nb1'])
  })

  it('offers to create a new folder', async () => {
    const w = mount(FolderTree, { props: { folders: [], selected: 'all', counts: {} }, ...teleportStub })
    await w.get('[data-testid="new-folder"]').trigger('click')
    expect(w.emitted('create')![0]).toEqual([null])
  })
})

describe('dialogs', () => {
  it('confirm resolves true/false', async () => {
    const w = mount(DialogHost, teleportStub)
    const p = confirmDialog({ title: 'Delete?', confirmLabel: 'Delete', danger: true })
    await flushPromises()
    expect(w.text()).toContain('Delete?')
    await w.findAll('button').find((b) => b.text() === 'Delete')!.trigger('click')
    expect(await p).toBe(true)
    const p2 = confirmDialog({ title: 'Again?' })
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Cancel')!.trigger('click')
    expect(await p2).toBe(false)
  })

  it('prompt returns the typed text; choose returns the picked value', async () => {
    const w = mount(DialogHost, teleportStub)
    const p = promptDialog({ title: 'Rename', value: 'old' })
    await flushPromises()
    const input = w.get('input')
    expect((input.element as HTMLInputElement).value).toBe('old')
    await input.setValue('new name')
    await w.get('form').trigger('submit')
    expect(await p).toBe('new name')

    const c = chooseDialog({ title: 'Move', options: [{ value: 'x', label: 'Folder X' }, { value: 'y', label: 'Folder Y', depth: 1 }] })
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Folder Y')!.trigger('click')
    expect(await c).toBe('y')
  })
})

describe('Menu', () => {
  it('opens on click and runs an item action', async () => {
    let ran = 0
    const w = mount(Menu, {
      props: { items: [{ label: 'Do it', action: () => ran++ }, { label: 'Nope', disabled: true, action: () => ran += 10 }] },
      slots: { default: '<button id="t">open</button>' },
      global: { stubs: { teleport: true } },
      attachTo: document.body,
    })
    expect(w.text()).not.toContain('Do it')
    await w.get('#t').trigger('click')
    expect(w.text()).toContain('Do it')
    await w.findAll('[role="menuitem"]')[1].trigger('click')
    expect(ran).toBe(0)
    await w.findAll('[role="menuitem"]')[0].trigger('click')
    expect(ran).toBe(1)
    expect(w.text()).not.toContain('Do it') // closed after selection
    w.unmount()
  })
})
