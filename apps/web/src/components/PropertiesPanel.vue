<script setup lang="ts">
import {
  QUICK_BACKGROUND_COLORS, QUICK_HIGHLIGHTER_COLORS, QUICK_STROKE_COLORS,
  type Arrowhead, type ArrowType, type FillStyle, type FontFamily, type ShapeKind, type StrokeLineStyle,
} from '@folio/document'
import {
  FONT_SIZE_PRESETS, HIGHLIGHTER_WIDTH_PRESETS, PEN_WIDTH_PRESETS, STROKE_WIDTH_PRESETS, type StyleProp,
} from '@folio/editor'
import { computed, inject, ref } from 'vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import { copyText } from '../services/export'
import { diagnostics } from '../services/diagnostics'
import { toast, toastError } from '../services/toast'
import ColorRow from './ColorRow.vue'
import Icon from './Icon.vue'
import OptionRow, { type Option } from './OptionRow.vue'
import StyleGlyph from './StyleGlyph.vue'

/**
 * Excalidraw-style properties panel. Entirely driven by `editor.styleContext()` (mirrored in ctl.styleCtx):
 * only applicable sections are shown, 'mixed' values show no active state, and every change goes through
 * ctl.setStyle -> editor.setStyle (selection AND defaults for new elements).
 */
const props = defineProps<{ placement: 'top' | 'bottom'; zen?: boolean }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const ctx = computed(() => ctl.styleCtx.value)
const sel = ctl.selection
const tool = ctl.tool
const opts = computed(() => ctl.options.value)

const COLLAPSE_KEY = 'folio.props.collapsed'
const collapsed = ref((() => { try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false } })())
function toggleCollapsed() {
  collapsed.value = !collapsed.value
  try { localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0') } catch { /* ignore */ }
}

const hasSel = computed(() => sel.value.count > 0)
const DRAW_TOOLS = ['pen', 'highlighter', 'eraser', 'shape', 'arrow', 'text']
const visible = computed(() => {
  if (props.zen) return hasSel.value
  if (hasSel.value) return true
  if (ctl.showToolOptions.value) return true
  return DRAW_TOOLS.includes(tool.value)
})
const has = (p: StyleProp) => !!ctx.value?.applicable.includes(p)
const val = <P extends StyleProp>(p: P) => ctx.value?.values[p]
const bg = computed(() => ctx.value?.canvasBackground ?? '#ffffff')
const str = (p: StyleProp) => val(p) as string | undefined

const isHighlighter = computed(() => (ctx.value?.source === 'selection' ? sel.value.highlighter : tool.value === 'highlighter'))
const isInkOnly = computed(() => (ctx.value?.source === 'selection' ? ctx.value.types.length > 0 && ctx.value.types.every((t) => t === 'ink') : tool.value === 'pen' || tool.value === 'highlighter'))
const strokeQuick = computed(() => (isHighlighter.value ? QUICK_HIGHLIGHTER_COLORS : QUICK_STROKE_COLORS))
const widthPresets = computed<readonly number[]>(() => (isHighlighter.value ? HIGHLIGHTER_WIDTH_PRESETS : isInkOnly.value ? PEN_WIDTH_PRESETS : STROKE_WIDTH_PRESETS))
const widthOptions = computed<Option<number>[]>(() => widthPresets.value.map((w, i) => ({ value: w, glyph: `w-${i}`, label: ['Thin', 'Bold', 'Extra bold'][i] })))
const showFill = computed(() => has('fillStyle') && val('backgroundColor') !== 'transparent')

const STROKE_STYLES: Option<StrokeLineStyle>[] = [
  { value: 'solid', glyph: 'ls-solid', label: 'Solid' }, { value: 'dashed', glyph: 'ls-dashed', label: 'Dashed' }, { value: 'dotted', glyph: 'ls-dotted', label: 'Dotted' },
]
const FILLS: Option<FillStyle>[] = [
  { value: 'hachure', glyph: 'fill-hachure', label: 'Hachure' }, { value: 'cross-hatch', glyph: 'fill-cross', label: 'Cross-hatch' }, { value: 'solid', glyph: 'fill-solid', label: 'Solid' },
]
const ROUGH: Option<number>[] = [
  { value: 0, glyph: 'rough-0', label: 'Architect' }, { value: 1, glyph: 'rough-1', label: 'Artist' }, { value: 2, glyph: 'rough-2', label: 'Cartoonist' },
]
const ARROW_TYPES: Option<ArrowType>[] = [
  { value: 'straight', glyph: 'at-straight', label: 'Straight arrow' }, { value: 'curved', glyph: 'at-curved', label: 'Curved arrow' }, { value: 'elbow', glyph: 'at-elbow', label: 'Elbow arrow' },
]
const HEADS: Option<Arrowhead>[] = [
  { value: 'none', glyph: 'head-none', label: 'None' }, { value: 'arrow', glyph: 'head-arrow', label: 'Arrow' }, { value: 'triangle', glyph: 'head-triangle', label: 'Triangle' },
  { value: 'dot', glyph: 'head-dot', label: 'Dot' }, { value: 'bar', glyph: 'head-bar', label: 'Bar' },
]
const FONTS: Option<FontFamily>[] = [
  { value: 'hand', glyph: 'ff-hand', label: 'Hand-drawn' }, { value: 'sans', glyph: 'ff-sans', label: 'Normal' }, { value: 'mono', glyph: 'ff-mono', label: 'Code' },
]
const SIZES: Option<number>[] = (Object.entries(FONT_SIZE_PRESETS) as [string, number][]).map(([k, v]) => ({ value: v, text: k, label: `Font size ${k}` }))
const ALIGNS: Option<'left' | 'center' | 'right'>[] = [
  { value: 'left', glyph: 'ta-left', label: 'Align left' }, { value: 'center', glyph: 'ta-center', label: 'Align center' }, { value: 'right', glyph: 'ta-right', label: 'Align right' },
]
const KINDS: ShapeKind[] = ['rectangle', 'ellipse', 'triangle', 'diamond', 'line']

const openHead = ref<'start' | 'end' | null>(null)
const headGlyph = (v: unknown) => `head-${typeof v === 'string' && v !== 'mixed' ? v : 'none'}`
function pickHead(which: 'start' | 'end', v: Arrowhead) {
  ctl.setStyle(which === 'start' ? { startHead: v } : { endHead: v })
  openHead.value = null
}
const opacityPct = computed(() => { const v = val('opacity'); return typeof v === 'number' ? Math.round(v * 100) : 100 })
const num = (e: Event) => Number((e.target as HTMLInputElement).value)

const busy = ref(false)
async function cleanUp() {
  const rec = ctl.recognitionApi
  if (!rec || busy.value) return
  busy.value = true
  try {
    const n = await rec.cleanUpSelection()
    if (n === 0) toast('Nothing to clean up here — the ink was not recognized with enough confidence.')
  } catch (e) {
    diagnostics.log('cleanup', e)
    toastError('Clean Up failed.')
  } finally { busy.value = false }
}
async function copy() {
  const text = ctl.recognitionApi?.selectionText() ?? ''
  if (!text) return toast('No recognized text in the selection yet.')
  toast((await copyText(text)) ? 'Text copied' : 'Could not copy', { kind: 'success' })
}
const e = () => ctl.editor.value!
const title = computed(() => (hasSel.value ? `${sel.value.count} selected` : { pen: 'Pen', highlighter: 'Highlighter', eraser: 'Eraser', shape: 'Shape', arrow: 'Arrow', text: 'Text', select: 'Selection' }[tool.value]))
</script>

<template>
  <div
    v-if="visible" class="props panel" :class="[placement, { zen, collapsed }]" role="region" aria-label="Properties"
    data-testid="properties-panel" @pointerdown.stop
  >
    <header class="head">
      <strong>{{ title }}</strong>
      <button class="icon-btn mini" type="button" :aria-label="collapsed ? 'Expand properties' : 'Collapse properties'" :aria-expanded="!collapsed" data-testid="props-collapse" @click="toggleCollapsed">
        <Icon :name="collapsed ? 'sliders' : 'down'" :size="18" />
      </button>
    </header>

    <div v-show="!collapsed" class="body">
      <!-- tool-only options -->
      <section v-if="!hasSel && tool === 'shape'" data-testid="sec-shape-kind">
        <label>Shape</label>
        <div class="kinds">
          <button v-for="k in KINDS" :key="k" type="button" class="opt" :class="{ on: opts?.shape.kind === k }" :aria-label="k" :aria-pressed="opts?.shape.kind === k"
                  :data-testid="`shape-${k}`" @click="ctl.setOption('shape', { kind: k })"><Icon :name="k" :size="20" /></button>
        </div>
      </section>
      <section v-if="!hasSel && tool === 'select'" data-testid="sec-select-mode">
        <label>Selection</label>
        <div class="seg">
          <button v-for="m in (['auto', 'rect', 'lasso'] as const)" :key="m" :class="{ on: opts?.select.mode === m }" @click="ctl.setOption('select', { mode: m })">{{ m === 'auto' ? 'Auto' : m === 'rect' ? 'Rectangle' : 'Lasso' }}</button>
        </div>
      </section>
      <section v-if="!hasSel && tool === 'eraser' && opts" data-testid="sec-eraser-size">
        <label>Eraser size <b>{{ opts.eraser.size }}</b></label>
        <input type="range" min="8" max="80" step="2" :value="opts.eraser.size" aria-label="Eraser size" @input="ctl.setOption('eraser', { size: num($event) })" />
      </section>

      <!-- Excalidraw order -->
      <section v-if="has('strokeColor')">
        <label>Stroke</label>
        <ColorRow label="Stroke" name="stroke" :quick="strokeQuick" :model-value="str('strokeColor')" :canvas-background="bg" :allow-transparent="false" @pick="(c) => ctl.setStyle({ strokeColor: c })" />
      </section>
      <section v-if="has('backgroundColor')">
        <label>Background</label>
        <ColorRow label="Background" name="background" :quick="QUICK_BACKGROUND_COLORS" :model-value="str('backgroundColor')" :canvas-background="bg" @pick="(c) => ctl.setStyle({ backgroundColor: c })" />
      </section>
      <section v-if="showFill" data-testid="sec-fillStyle">
        <label>Fill</label>
        <OptionRow name="Fill style" :options="FILLS" :model-value="val('fillStyle')" @pick="(v) => ctl.setStyle({ fillStyle: v })" />
      </section>
      <section v-if="has('strokeWidth')" data-testid="sec-strokeWidth">
        <label>Stroke width</label>
        <OptionRow name="Stroke width" :options="widthOptions" :model-value="val('strokeWidth')" @pick="(v) => ctl.setStyle({ strokeWidth: v })" />
      </section>
      <section v-if="has('strokeStyle')" data-testid="sec-strokeStyle">
        <label>Stroke style</label>
        <OptionRow name="Stroke style" :options="STROKE_STYLES" :model-value="val('strokeStyle')" @pick="(v) => ctl.setStyle({ strokeStyle: v })" />
      </section>
      <section v-if="has('roughness')" data-testid="sec-roughness">
        <label>Sloppiness</label>
        <OptionRow name="Sloppiness" :options="ROUGH" :model-value="val('roughness')" @pick="(v) => ctl.setStyle({ roughness: v })" />
      </section>
      <section v-if="has('arrowType')" data-testid="sec-arrowType">
        <label>Arrow type</label>
        <OptionRow name="Arrow type" :options="ARROW_TYPES" :model-value="val('arrowType')" @pick="(v) => ctl.setStyle({ arrowType: v })" />
      </section>
      <section v-if="has('startHead') || has('endHead')" data-testid="sec-arrowheads">
        <label>Arrowheads</label>
        <div class="heads">
          <button type="button" class="opt" :class="{ on: openHead === 'start' }" aria-label="Start arrowhead" aria-haspopup="listbox" :aria-expanded="openHead === 'start'"
                  data-testid="head-start" @click="openHead = openHead === 'start' ? null : 'start'"><StyleGlyph :name="headGlyph(val('startHead'))" flip /></button>
          <button type="button" class="opt" :class="{ on: openHead === 'end' }" aria-label="End arrowhead" aria-haspopup="listbox" :aria-expanded="openHead === 'end'"
                  data-testid="head-end" @click="openHead = openHead === 'end' ? null : 'end'"><StyleGlyph :name="headGlyph(val('endHead'))" /></button>
        </div>
        <div v-if="openHead" class="head-list" role="listbox" :aria-label="`${openHead} arrowhead`">
          <button v-for="h in HEADS" :key="h.value" type="button" class="opt" role="option" :class="{ on: val(openHead === 'start' ? 'startHead' : 'endHead') === h.value }"
                  :aria-selected="val(openHead === 'start' ? 'startHead' : 'endHead') === h.value" :aria-label="h.label" :title="h.label"
                  :data-testid="`head-${openHead}-${h.value}`" @click="pickHead(openHead, h.value)"><StyleGlyph :name="h.glyph!" :flip="openHead === 'start'" /></button>
        </div>
      </section>
      <section v-if="has('fontFamily')" data-testid="sec-fontFamily">
        <label>Font family</label>
        <OptionRow name="Font family" :options="FONTS" :model-value="val('fontFamily')" @pick="(v) => ctl.setStyle({ fontFamily: v })" />
      </section>
      <section v-if="has('fontSize')" data-testid="sec-fontSize">
        <label>Font size</label>
        <OptionRow name="Font size" :options="SIZES" :model-value="val('fontSize')" @pick="(v) => ctl.setStyle({ fontSize: v })" />
      </section>
      <section v-if="has('textAlign')" data-testid="sec-textAlign">
        <label>Text align</label>
        <OptionRow name="Text align" :options="ALIGNS" :model-value="val('textAlign')" @pick="(v) => ctl.setStyle({ textAlign: v })" />
      </section>
      <section v-if="has('opacity')" data-testid="sec-opacity">
        <label>Opacity</label>
        <input type="range" min="0" max="100" step="1" :value="opacityPct" aria-label="Opacity" data-testid="opacity-slider" @input="ctl.setStyle({ opacity: num($event) / 100 }, 'opacity')" />
        <div class="scale"><span>0</span><span v-if="val('opacity') === 'mixed'">mixed</span><span>100</span></div>
      </section>

      <template v-if="hasSel && !ctl.editingText.value">
        <section data-testid="sec-layers">
          <label>Layers</label>
          <div class="opt-row">
            <button type="button" class="opt" aria-label="Send to back" title="Send to back" data-testid="layer-back" @click="ctl.sendToBack()"><StyleGlyph name="ly-back" /></button>
            <button type="button" class="opt" aria-label="Send backward" title="Send backward" data-testid="layer-backward" @click="ctl.sendBackward()"><StyleGlyph name="ly-backward" /></button>
            <button type="button" class="opt" aria-label="Bring forward" title="Bring forward" data-testid="layer-forward" @click="ctl.bringForward()"><StyleGlyph name="ly-forward" /></button>
            <button type="button" class="opt" aria-label="Bring to front" title="Bring to front" data-testid="layer-front" @click="ctl.bringToFront()"><StyleGlyph name="ly-front" /></button>
          </div>
        </section>
        <section class="actions" data-testid="selection-bar" role="toolbar" aria-label="Selection actions">
          <label>Actions</label>
          <div class="opt-row">
            <button v-if="sel.ink" class="btn small" data-testid="cleanup" :disabled="busy" @click="cleanUp"><Icon name="cleanup" :size="18" /> {{ busy ? 'Working…' : 'Clean Up' }}</button>
            <button v-if="sel.derived" class="btn small" data-testid="restore-ink" @click="ctl.recognitionApi?.restoreSelection()"><Icon name="restore" :size="18" /> Restore ink</button>
            <button class="opt" aria-label="Duplicate" title="Duplicate" data-testid="duplicate" @click="e().duplicateSelection()"><Icon name="copy" :size="20" /></button>
            <button v-if="sel.count > 1" class="opt" aria-label="Group" title="Group" @click="e().groupSelection()"><Icon name="group" :size="20" /></button>
            <button v-if="sel.group" class="opt" aria-label="Ungroup" title="Ungroup" @click="e().ungroupSelection()"><Icon name="ungroup" :size="20" /></button>
            <button v-if="sel.text" class="opt" aria-label="Copy recognized text" title="Copy text" @click="copy"><Icon name="doc" :size="20" /></button>
            <button class="opt danger" aria-label="Delete" title="Delete" data-testid="delete-selection" @click="e().deleteSelection()"><Icon name="trash" :size="20" /></button>
          </div>
        </section>
      </template>
      <section v-if="!hasSel && (tool === 'pen' || tool === 'highlighter') && opts" class="check-row">
        <label class="check"><input type="checkbox" :checked="opts[tool].pressureSensitive" data-testid="pressure" @change="ctl.setOption(tool, { pressureSensitive: ($event.target as HTMLInputElement).checked })" /> Pressure sensitivity</label>
      </section>
    </div>
  </div>
</template>

<style scoped>
.props { position: absolute; z-index: 21; display: flex; flex-direction: column; width: 232px; max-height: calc(100% - 200px); }
.props.top { left: calc(8px + var(--safe-left)); top: calc(126px + var(--safe-top)); }
.props.bottom { left: calc(8px + var(--safe-left)); right: calc(8px + var(--safe-right)); bottom: calc(74px + var(--safe-bottom)); width: auto; max-height: 46vh; margin: 0 auto; max-width: 460px; }
.props.zen { top: 70px; opacity: 0.96; }
.head { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 0 14px; min-height: 36px; }
.head strong { font-size: 13px; }
.mini { width: 34px; height: 34px; }
.body { overflow-y: auto; padding: 2px 14px 12px; display: flex; flex-direction: column; gap: 10px; overscroll-behavior: contain; }
.props.bottom .body { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px 16px; }
section { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
section > label { font-size: 12.5px; font-weight: 600; color: var(--muted); display: flex; justify-content: space-between; }
section > label b { color: var(--text); }
.kinds { display: flex; gap: 4px; flex-wrap: wrap; }
.opt-row { display: flex; flex-wrap: wrap; gap: 6px; }
.opt {
  width: 40px; height: 38px; border-radius: 9px; border: 1px solid transparent; background: var(--surface-2); color: var(--text);
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
}
.opt:hover { background: var(--surface-3); }
.opt.on { background: var(--accent-soft); color: var(--accent-strong); border-color: var(--accent); }
.opt.danger { color: var(--danger); }
.opt:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.heads { display: flex; gap: 6px; }
.head-list { display: flex; gap: 4px; flex-wrap: wrap; padding: 6px; border-radius: 10px; background: var(--surface-2); }
.head-list .opt { background: var(--surface); width: 36px; }
.scale { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-top: -4px; }
.check { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text) !important; font-weight: 500 !important; }
.check input { width: 20px; height: 20px; accent-color: var(--accent); }
.actions .btn { min-height: 38px; }
.collapsed { width: auto; }
.props.bottom.collapsed { left: auto; right: calc(8px + var(--safe-right)); }
</style>
