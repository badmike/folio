import { PALETTE, QUICK_HIGHLIGHTER_COLORS, adaptColor, defaultQuickColors } from '@folio/document'
import type { StyleContext } from '@folio/editor'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef } from 'vue'
import { GRID_KEYS, colorForHue, normalizeHex, shadesFor } from '../src/color-ui'
import ColorPicker from '../src/components/ColorPicker.vue'
import PropertiesPanel from '../src/components/PropertiesPanel.vue'
import Toolbar from '../src/components/Toolbar.vue'
import { NOTEBOOK_KEY } from '../src/notebook'
import { DEFAULT_SETTINGS, sanitizeSettings, settings, toggleZen } from '../src/services/settings'

const teleportStub = { global: { stubs: { teleport: true } } }

describe('color-ui helpers', () => {
  it('normalises and validates hex codes', () => {
    expect(normalizeHex('F00')).toBe('#ff0000')
    expect(normalizeHex('#1E1E1E')).toBe('#1e1e1e')
    expect(normalizeHex(' 12345678 ')).toBe('#12345678')
    expect(normalizeHex('12')).toBeNull()
    expect(normalizeHex('gg0000')).toBeNull()
  })
  it('offers shades for hues but not for black / white / transparent', () => {
    expect(shadesFor('#4dabf7')).toHaveLength(5) // blue default swatch
    expect(shadesFor('#1971c2')).toHaveLength(5) // a non-default shade of blue
    expect(shadesFor('#1e1e1e')).toEqual([])
    expect(shadesFor('#ffffff')).toEqual([])
    expect(shadesFor('transparent')).toEqual([])
    expect(shadesFor('#123456')).toEqual([])
  })
  it('keeps the current shade index when switching hue', () => {
    const blue = PALETTE.findIndex((h) => h.name === 'blue')
    const red = PALETTE.findIndex((h) => h.name === 'red')
    expect(colorForHue(red, PALETTE[blue].shades[4])).toBe(PALETTE[red].shades[4])
    expect(colorForHue(red, '#123456')).toBe(PALETTE[red].shades[3])
  })
  it('has one keyboard letter per hue', () => {
    expect(GRID_KEYS).toHaveLength(PALETTE.length)
    expect(new Set(GRID_KEYS).size).toBe(GRID_KEYS.length)
  })
})

describe('ColorPicker', () => {
  const mountPicker = (modelValue = '#1e1e1e', extra: Record<string, unknown> = {}) => mount(ColorPicker, { props: { modelValue, ...extra }, attachTo: document.body })
  const last = (w: ReturnType<typeof mountPicker>) => w.emitted('update:modelValue')!.at(-1)![0]
  afterEach(() => { document.body.innerHTML = '' })

  it('selects a palette hue on click (canonical colour, not the adapted preview)', async () => {
    const w = mountPicker('#1e1e1e', { background: '#121212' })
    await w.get('[data-testid="hue-blue"]').trigger('click')
    expect(last(w)).toBe(PALETTE.find((h) => h.name === 'blue')!.shades[3])
    // swatches are previewed adapted to the dark page
    const style = (w.get('[data-testid="hue-black"]').element as HTMLElement).style.background
    expect(style).not.toBe('')
    expect(adaptColor('#1e1e1e', '#121212')).not.toBe('#1e1e1e')
    w.unmount()
  })

  it('shows shades for a hue and applies one; "no shades" for black', async () => {
    const w = mountPicker('#4dabf7')
    expect(w.findAll('[data-testid^="shade-"]')).toHaveLength(5)
    await w.get('[data-testid="shade-5"]').trigger('click')
    expect(last(w)).toBe('#1971c2')
    await w.setProps({ modelValue: '#1e1e1e' })
    expect(w.find('[data-testid="no-shades"]').text()).toBe('No shades available for this color')
    w.unmount()
  })

  it('validates the hex input and applies on Enter / blur', async () => {
    const w = mountPicker()
    const input = w.get('[data-testid="hex-input"]')
    await input.setValue('zzz')
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('update:modelValue')).toBeUndefined()
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(w.find('[role="alert"]').exists()).toBe(true)
    await input.setValue('ABC')
    await input.trigger('keydown', { key: 'Enter' })
    expect(last(w)).toBe('#aabbcc')
    await input.setValue('12ab34')
    await input.trigger('blur')
    expect(last(w)).toBe('#12ab34')
    w.unmount()
  })

  it('handles keyboard letters (hues), digits (shades) and Escape', async () => {
    const w = mountPicker('#4dabf7')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }))
    expect(last(w)).toBe(PALETTE[10].shades[3]) // z = first of third row = green
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    expect(last(w)).toBe('#d0ebff')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
  })

  it('ignores letters typed into the hex field and forbids transparent for strokes', async () => {
    const w = mountPicker('#1e1e1e', { allowTransparent: false })
    const input = w.get('[data-testid="hex-input"]').element as HTMLInputElement
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true }))
    expect(w.emitted('update:modelValue')).toBeUndefined()
    expect((w.get('[data-testid="hue-transparent"]').element as HTMLButtonElement).disabled).toBe(true)
    w.unmount()
  })

  it('closes on outside pointer down', async () => {
    const w = mountPicker()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
  })
})

// ---- properties panel -------------------------------------------------------------------------

function fakeController(ctx: StyleContext, over: Record<string, unknown> = {}) {
  const setStyle = vi.fn()
  const ctl = {
    styleCtx: shallowRef(ctx),
    selection: shallowRef({ count: ctx.source === 'selection' ? 1 : 0, ink: false, derived: false, text: false, group: false, frame: false, highlighter: false }),
    quickColors: shallowRef(defaultQuickColors()),
    locked: ref(false),
    toolLock: ref(false),
    setQuickColor: vi.fn(), alignSelection: vi.fn(), distributeSelection: vi.fn(), setToolLock: vi.fn(), setLocked: vi.fn(),
    tool: ref('shape'),
    options: shallowRef({ shape: { kind: 'rectangle' }, select: { mode: 'auto' }, eraser: { size: 20 }, pen: { pressureSensitive: true }, highlighter: { pressureSensitive: false } }),
    editingText: ref(false),
    showToolOptions: ref(false),
    setStyle, setOption: vi.fn(), sendToBack: vi.fn(), bringToFront: vi.fn(), sendBackward: vi.fn(), bringForward: vi.fn(),
    editor: shallowRef({}), recognitionApi: null,
    ...over,
  }
  return { ctl, setStyle }
}
const shapeValues = { strokeColor: '#e03131', backgroundColor: 'transparent', fillStyle: 'hachure', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 1 } as StyleContext['values']
const mountPanel = (ctl: unknown, props: Record<string, unknown> = {}) =>
  mount(PropertiesPanel, { props, global: { provide: { [NOTEBOOK_KEY as symbol]: ctl }, stubs: { teleport: true } } })

describe('PropertiesPanel', () => {
  it('shows only the applicable sections, in Excalidraw order', () => {
    const { ctl } = fakeController({
      source: 'tool', types: [], canvasBackground: '#ffffff', values: shapeValues,
      applicable: ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity'],
    })
    const w = mountPanel(ctl)
    const labels = w.findAll('section > label').map((l) => l.text())
    expect(labels).toEqual(['Shape', 'Stroke', 'Background', 'Stroke width', 'Stroke style', 'Sloppiness', 'Opacity'])
    expect(w.find('[data-testid="sec-fillStyle"]').exists()).toBe(false) // transparent background => no fill row
    expect(w.find('[data-testid="sec-arrowType"]').exists()).toBe(false)
    expect(w.find('[data-testid="sec-fontSize"]').exists()).toBe(false)
    expect(w.find('[data-testid="sec-layers"]').exists()).toBe(false) // layers only for selections
  })

  it('shows fill styles once the background is not transparent and applies changes via setStyle', async () => {
    const { ctl, setStyle } = fakeController({
      source: 'tool', types: [], canvasBackground: '#ffffff', values: { ...shapeValues, backgroundColor: '#ffc9c9' },
      applicable: ['strokeColor', 'backgroundColor', 'fillStyle', 'opacity'],
    })
    const w = mountPanel(ctl)
    expect(w.find('[data-testid="sec-fillStyle"]').exists()).toBe(true)
    await w.get('[data-testid="fill-style-solid"]').trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ fillStyle: 'solid' })
    await w.get('[aria-label="Stroke #2f9e44"]').trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ strokeColor: '#2f9e44' })
    await w.get('[data-testid="opacity-slider"]').setValue('40')
    expect(setStyle).toHaveBeenLastCalledWith({ opacity: 0.4 }, 'opacity')
  })

  it('uses highlighter quick colours and marks the active preset; mixed values have no active state', () => {
    const { ctl } = fakeController({
      source: 'tool', types: [], canvasBackground: '#ffffff',
      values: { strokeColor: QUICK_HIGHLIGHTER_COLORS[0], strokeWidth: 'mixed', opacity: 0.35 },
      applicable: ['strokeColor', 'strokeWidth', 'opacity'],
    }, { tool: ref('highlighter') })
    const w = mountPanel(ctl)
    expect(w.find(`[aria-label="Stroke ${QUICK_HIGHLIGHTER_COLORS[2]}"]`).exists()).toBe(true)
    expect(w.findAll('[data-testid^="stroke-width-"]').filter((b) => b.classes('on'))).toHaveLength(0)
    expect(w.get(`[aria-label="Stroke ${QUICK_HIGHLIGHTER_COLORS[0]}"]`).attributes('aria-pressed')).toBe('true')
  })

  it('renders text and arrow sections for a text selection with layers and actions', async () => {
    const { ctl, setStyle } = fakeController({
      source: 'selection', types: ['text'], canvasBackground: '#121212',
      values: { strokeColor: '#1e1e1e', fontFamily: 'sans', fontSize: 28, textAlign: 'center', opacity: 1 },
      applicable: ['strokeColor', 'fontFamily', 'fontSize', 'textAlign', 'opacity'],
    })
    const w = mountPanel(ctl)
    expect(w.get('[data-testid="font-size-28"]').classes()).toContain('on')
    expect(w.get('[data-testid="font-family-sans"]').classes()).toContain('on')
    await w.get('[data-testid="font-family-hand"]').trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ fontFamily: 'hand' })
    // every other font sits in the "more fonts" popover
    await w.get('[data-testid="font-family-more"]').trigger('click')
    await w.findAll('[role="menuitem"]').find((b) => b.text() === 'Kalam')!.trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ fontFamily: 'kalam' })
    expect(w.get('[data-testid="text-align-center"]').classes()).toContain('on')
    await w.get('[data-testid="font-size-36"]').trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ fontSize: 36 })
    await w.get('[data-testid="layer-forward"]').trigger('click')
    expect(ctl.bringForward).toHaveBeenCalled()
    expect(w.find('[data-testid="delete-selection"]').exists()).toBe(true)
  })

  it('offers arrow type and start / end arrowhead pickers', async () => {
    const { ctl, setStyle } = fakeController({
      source: 'tool', types: [], canvasBackground: '#ffffff',
      values: { strokeColor: '#1e1e1e', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 1, arrowType: 'straight', startHead: 'none', endHead: 'arrow' },
      applicable: ['strokeColor', 'strokeWidth', 'strokeStyle', 'roughness', 'arrowType', 'startHead', 'endHead', 'opacity'],
    }, { tool: ref('arrow') })
    const w = mountPanel(ctl)
    expect(w.find('[data-testid="sec-backgroundColor"]').exists()).toBe(false)
    await w.get('[data-testid="arrow-type-curved"]').trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ arrowType: 'curved' })
    await w.get('[data-testid="head-start"]').trigger('click')
    await w.get('[data-testid="head-start-triangle"]').trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ startHead: 'triangle' })
    expect(w.find('[data-testid="head-start-dot"]').exists()).toBe(false) // list closed after picking
  })

  it('is hidden without applicable tool context, and in zen mode unless something is selected', async () => {
    const { ctl } = fakeController({ source: 'tool', types: [], canvasBackground: '#fff', values: {}, applicable: [] }, { tool: ref('select') })
    expect(mountPanel(ctl).find('[data-testid="properties-panel"]').exists()).toBe(false)
    const drawing = fakeController({ source: 'tool', types: [], canvasBackground: '#fff', values: { strokeColor: '#1e1e1e', opacity: 1 }, applicable: ['strokeColor', 'opacity'] }, { tool: ref('pen') })
    expect(mountPanel(drawing.ctl).find('[data-testid="properties-panel"]').exists()).toBe(true)
    // zen: ink tools keep the quick bar, other tools show nothing
    expect(mountPanel(drawing.ctl, { zen: true }).find('[data-testid="props-quick"]').exists()).toBe(true)
    const shapeTool = fakeController({ source: 'tool', types: [], canvasBackground: '#fff', values: { strokeColor: '#1e1e1e' }, applicable: ['strokeColor'] }, { tool: ref('shape') })
    expect(mountPanel(shapeTool.ctl, { zen: true }).find('[data-testid="properties-panel"]').exists()).toBe(false)
    const selected = fakeController({ source: 'selection', types: ['ink'], canvasBackground: '#fff', values: { strokeColor: '#1e1e1e', opacity: 1 }, applicable: ['strokeColor', 'opacity'] })
    expect(mountPanel(selected.ctl, { zen: true }).find('[data-testid="properties-panel"]').exists()).toBe(true)
  })

  it('collapses into a quick bar with colours and widths', async () => {
    const { ctl, setStyle } = fakeController({ source: 'tool', types: [], canvasBackground: '#fff', values: { strokeColor: '#1e1e1e', strokeWidth: 2 }, applicable: ['strokeColor', 'strokeWidth'] }, { tool: ref('pen') })
    const w = mountPanel(ctl)
    await w.get('[data-testid="props-collapse"]').trigger('click')
    expect(w.find('.body').exists()).toBe(false)
    expect(w.find('[data-testid="props-quick"]').exists()).toBe(true)
    await w.get('[data-testid="stroke-width-4"]').trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ strokeWidth: 4 })
    expect(w.find('[data-testid="stroke-color-btn"]').exists()).toBe(false) // swatches only
    await w.get('[data-testid="props-collapse"]').trigger('click')
    expect(w.find('.body').exists()).toBe(true)
  })

  it('shows highlighter edges, corners, pixel size and label size when applicable', async () => {
    const { ctl, setStyle } = fakeController({
      source: 'selection', types: ['ink', 'shape'], canvasBackground: '#fff',
      values: { strokeColor: '#1e1e1e', cap: 'flat', roundness: 'sharp', blurMode: 'pixelate', blurSize: 12, fontSize: 20 },
      applicable: ['strokeColor', 'cap', 'roundness', 'blurMode', 'blurSize', 'fontSize'],
    })
    const w = mountPanel(ctl)
    await w.get('[data-testid="edges-curvy"]').trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ cap: 'curvy' })
    await w.get('[data-testid="corners-round"]').trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ roundness: 'round' })
    await w.get('[data-testid="blur-size"]').setValue('24')
    expect(setStyle).toHaveBeenLastCalledWith({ blurSize: 24 }, 'blurSize')
    await w.get('[data-testid="blur-mode-gaussian"]').trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ blurMode: 'gaussian' })
    expect(w.find('[data-testid="sec-fontSize"]').exists()).toBe(true)
  })

  it('offers align (2+) and distribute (3+) for multi-selections', async () => {
    const two = fakeController({ source: 'selection', types: ['shape'], canvasBackground: '#fff', values: {}, applicable: [] })
    two.ctl.selection.value = { ...two.ctl.selection.value, count: 2 }
    const w = mountPanel(two.ctl)
    await w.get('[data-testid="align-centerX"]').trigger('click')
    expect(two.ctl.alignSelection).toHaveBeenCalledWith('centerX')
    expect(w.find('[data-testid="distribute-horizontal"]').exists()).toBe(false)
    two.ctl.selection.value = { ...two.ctl.selection.value, count: 3 }
    await flushPromises()
    await w.get('[data-testid="distribute-horizontal"]').trigger('click')
    expect(two.ctl.distributeSelection).toHaveBeenCalledWith('horizontal')
  })

  it('a long press on a quick swatch opens the picker to change that swatch', async () => {
    vi.useFakeTimers()
    const { ctl, setStyle } = fakeController({ source: 'tool', types: [], canvasBackground: '#fff', values: { strokeColor: '#1e1e1e' }, applicable: ['strokeColor'] }, { tool: ref('pen') })
    const w = mountPanel(ctl)
    const sw = w.get('[data-testid="stroke-quick-#e03131"]')
    await sw.trigger('pointerdown')
    vi.advanceTimersByTime(500)
    await flushPromises()
    await sw.trigger('pointerup')
    await sw.trigger('click')
    expect(setStyle).not.toHaveBeenCalled()
    expect(w.find('[data-testid="color-picker"]').exists()).toBe(true)
    await w.get('[data-testid="hue-blue"]').trigger('click')
    // the swatch was red shade 5, so blue keeps that shade
    expect(ctl.setQuickColor).toHaveBeenCalledWith('stroke', 1, PALETTE.find((h) => h.name === 'blue')!.shades[4])
    vi.useRealTimers()
  })

  it('a short tap on a quick swatch applies it', async () => {
    const { ctl, setStyle } = fakeController({ source: 'tool', types: [], canvasBackground: '#fff', values: { strokeColor: '#1e1e1e' }, applicable: ['strokeColor'] }, { tool: ref('pen') })
    const w = mountPanel(ctl)
    const sw = w.get('[data-testid="stroke-quick-#e03131"]')
    await sw.trigger('pointerdown')
    await sw.trigger('pointerup')
    await sw.trigger('click')
    expect(setStyle).toHaveBeenLastCalledWith({ strokeColor: '#e03131' })
  })
})

describe('zen mode', () => {
  afterEach(() => { settings.zen = false })
  it('toggles and persists via settings sanitising', () => {
    expect(settings.zen).toBe(false)
    toggleZen()
    expect(settings.zen).toBe(true)
    expect(sanitizeSettings({ zen: true }).zen).toBe(true)
    expect(sanitizeSettings({ zen: 'yes' }).zen).toBe(DEFAULT_SETTINGS.zen)
    toggleZen(false)
    expect(settings.zen).toBe(false)
  })

  it('shows a reduced tool strip that expands, and wakes on hover', async () => {
    const { ctl } = fakeController({ source: 'tool', types: [], canvasBackground: '#fff', values: {}, applicable: [] }, {
      canUndo: ref(false), canRedo: ref(false), undo: vi.fn(), redo: vi.fn(), setTool: vi.fn(),
    })
    const w = mount(Toolbar, { props: { zen: true, faded: true }, global: { provide: { [NOTEBOOK_KEY as symbol]: ctl } } })
    expect(w.findAll('[data-testid^="tool-"]').map((b) => b.attributes('data-testid'))).toEqual(['tool-lock', 'tool-select', 'tool-pen', 'tool-highlighter', 'tool-eraser'])
    expect(w.find('[data-testid="redo"]').exists()).toBe(false)
    expect(w.classes()).toContain('faded')
    await w.trigger('pointerenter')
    expect(w.emitted('wake')).toBeTruthy()
    await w.get('[data-testid="zen-more"]').trigger('click')
    expect(w.findAll('[data-testid^="tool-"]')).toHaveLength(11)
    await flushPromises()
  })
})
