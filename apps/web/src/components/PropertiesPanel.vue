<script setup lang="ts">
import {
  DRAWABLE_SHAPE_KINDS,
  type Arrowhead, type ArrowType, type BlurMode, type FillStyle, type FontFamily, type HighlighterCap, type Roundness, type StrokeLineStyle,
} from '@folio/document'
import { FONT_SIZE_PRESETS, STROKE_WIDTH_PRESETS, type AlignMode, type DistributeAxis, type StyleProp } from '@folio/editor'
import { FONT_FAMILIES, FONT_LABELS } from '@folio/renderer'
import { computed, inject, ref } from 'vue'
import type { IconName } from '../icons'
import { NOTEBOOK_KEY, type NotebookController, type QuickColorSet } from '../notebook'
import { copyText } from '../services/export'
import { diagnostics } from '../services/diagnostics'
import { toast, toastError } from '../services/toast'
import ColorRow from './ColorRow.vue'
import Icon from './Icon.vue'
import Menu, { type MenuItem } from './Menu.vue'
import OptionRow, { type Option } from './OptionRow.vue'
import StyleGlyph from './StyleGlyph.vue'

/**
 * Excalidraw-style properties panel. Entirely driven by `editor.styleContext()` (mirrored in ctl.styleCtx):
 * only applicable sections are shown, 'mixed' values show no active state, and every change goes through
 * ctl.setStyle -> editor.setStyle (selection AND defaults for new elements).
 *
 * Collapsed, it turns into a one-row "quick bar" (colours + widths) so colours can be switched while
 * taking notes without the full panel in the way.
 */
const props = defineProps<{ zen?: boolean; hudHidden?: boolean }>()
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
const DRAW_TOOLS = ['pen', 'highlighter', 'eraser', 'shape', 'arrow', 'text', 'frame', 'blur']
const visible = computed(() => {
  if (ctl.locked.value) return false
  if (props.zen) return hasSel.value || tool.value === 'pen' || tool.value === 'highlighter'
  if (hasSel.value) return true
  if (ctl.showToolOptions.value) return true
  return DRAW_TOOLS.includes(tool.value)
})
/** Zen mode only ever shows the quick bar for ink tools. */
const compact = computed(() => collapsed.value || props.hudHidden || (!!props.zen && !hasSel.value))
const has = (p: StyleProp) => !!ctx.value?.applicable.includes(p)
const val = <P extends StyleProp>(p: P) => ctx.value?.values[p]
const bg = computed(() => ctx.value?.canvasBackground ?? '#ffffff')
const str = (p: StyleProp) => val(p) as string | undefined

const isHighlighter = computed(() => (ctx.value?.source === 'selection' ? sel.value.highlighter : tool.value === 'highlighter'))
const quick = ctl.quickColors
const strokeSet = computed<QuickColorSet>(() => (isHighlighter.value ? 'highlighter' : 'stroke'))
const strokeQuick = computed(() => quick.value[strokeSet.value])
// The editor exposes strokeWidth in one shared preset space (1 / 2 / 4); it maps to the pen / highlighter
// preset widths (PEN_WIDTH_PRESETS / HIGHLIGHTER_WIDTH_PRESETS) internally for ink.
const widthOptions: Option<number>[] = STROKE_WIDTH_PRESETS.map((w, i) => ({ value: w, glyph: `w-${i}`, label: ['Thin', 'Bold', 'Extra bold'][i] }))
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
const BLUR_MODES: Option<BlurMode>[] = [{ value: 'pixelate', glyph: 'blur-pixelate', label: 'Pixelate' }, { value: 'gaussian', glyph: 'blur-gaussian', label: 'Gaussian blur' }]
const CORNERS: Option<Roundness>[] = [{ value: 'sharp', glyph: 'corner-sharp', label: 'Sharp' }, { value: 'round', glyph: 'corner-round', label: 'Round' }]
const CAPS: Option<HighlighterCap>[] = [
  { value: 'flat', glyph: 'cap-flat', label: 'Flat' }, { value: 'round', glyph: 'cap-round', label: 'Round' },
  { value: 'slanted', glyph: 'cap-slanted', label: 'Slanted' }, { value: 'curvy', glyph: 'cap-curvy', label: 'Curvy' },
]
const ARROW_TYPES: Option<ArrowType>[] = [
  { value: 'straight', glyph: 'at-straight', label: 'Straight arrow' }, { value: 'curved', glyph: 'at-curved', label: 'Curved arrow' }, { value: 'elbow', glyph: 'at-elbow', label: 'Elbow arrow' },
]
const HEADS: Option<Arrowhead>[] = [
  { value: 'none', glyph: 'head-none', label: 'None' }, { value: 'arrow', glyph: 'head-arrow', label: 'Arrow' }, { value: 'triangle', glyph: 'head-triangle', label: 'Triangle' },
  { value: 'dot', glyph: 'head-dot', label: 'Dot' }, { value: 'bar', glyph: 'head-bar', label: 'Bar' },
]
const SIZES: Option<number>[] = (Object.entries(FONT_SIZE_PRESETS) as [string, number][]).map(([k, v]) => ({ value: v, text: k, label: `Font size ${k}` }))
const ALIGNS: Option<'left' | 'center' | 'right'>[] = [
  { value: 'left', glyph: 'ta-left', label: 'Align left' }, { value: 'center', glyph: 'ta-center', label: 'Align center' }, { value: 'right', glyph: 'ta-right', label: 'Align right' },
]
/** One row per axis: its three align modes, then (for three or more items) distribute along that axis. */
const ALIGN_ROWS: { axis: DistributeAxis; distributeIcon: IconName; modes: { mode: AlignMode; icon: IconName; label: string }[] }[] = [
  { axis: 'horizontal', distributeIcon: 'distribute-x', modes: [
    { mode: 'left', icon: 'align-left', label: 'Align left' }, { mode: 'centerX', icon: 'align-center-x', label: 'Center horizontally' }, { mode: 'right', icon: 'align-right', label: 'Align right' },
  ] },
  { axis: 'vertical', distributeIcon: 'distribute-y', modes: [
    { mode: 'top', icon: 'align-top', label: 'Align top' }, { mode: 'centerY', icon: 'align-center-y', label: 'Center vertically' }, { mode: 'bottom', icon: 'align-bottom', label: 'Align bottom' },
  ] },
]

/** Hand-drawn, normal and code are one tap away; every other bundled font sits in the "more fonts" popover. */
const FONTS: Option<FontFamily>[] = [
  { value: 'hand', glyph: 'ff-hand', label: 'Hand-drawn' }, { value: 'sans', glyph: 'ff-sans', label: 'Normal' }, { value: 'mono', glyph: 'ff-mono', label: 'Code' },
]
const EXTRA_FONTS = FONT_LABELS.filter((f) => !FONTS.some((o) => o.value === f.family))
const customFont = computed(() => EXTRA_FONTS.find((f) => f.family === val('fontFamily')))
const moreFonts = computed<MenuItem[]>(() => EXTRA_FONTS.map((f) => ({
  label: f.label, fontFamily: FONT_FAMILIES[f.family], active: f.family === customFont.value?.family, action: () => ctl.setStyle({ fontFamily: f.family }),
})))

const openHead = ref<'start' | 'end' | null>(null)
const headGlyph = (v: unknown) => `head-${typeof v === 'string' && v !== 'mixed' ? v : 'none'}`
function pickHead(which: 'start' | 'end', v: Arrowhead) {
  ctl.setStyle(which === 'start' ? { startHead: v } : { endHead: v })
  openHead.value = null
}
const opacityPct = computed(() => { const v = val('opacity'); return typeof v === 'number' ? Math.round(v * 100) : 100 })
const blurSize = computed(() => { const v = val('blurSize'); return typeof v === 'number' ? v : 12 })
const num = (e: Event) => Number((e.target as HTMLInputElement).value)

const busy = ref(false)
async function cleanUp() {
  const rec = ctl.recognitionApi
  if (!rec || busy.value) return
  busy.value = true
  try {
    const n = await rec.cleanUpSelection()
    if (n === 0) toast('Nothing to clean up here. The ink was not recognized with enough confidence.')
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
const TOOL_TITLES: Record<string, string> = {
  pen: 'Pen', highlighter: 'Highlighter', eraser: 'Eraser', shape: 'Shape', arrow: 'Arrow', text: 'Text', select: 'Selection', hand: 'Hand', frame: 'Frame', blur: 'Blur',
}
const title = computed(() => (hasSel.value ? `${sel.value.count} selected` : TOOL_TITLES[tool.value] ?? ''))
</script>

<template>
  <div
    v-if="visible" class="props panel floating" :class="{ zen, compact, docked: hudHidden }" role="region" aria-label="Properties"
    data-testid="properties-panel" @pointerdown.stop
  >
    <!-- quick bar: colours and widths in one row -->
    <div v-if="compact" class="quick" data-testid="props-quick">
      <ColorRow v-if="has('strokeColor')" label="Stroke" name="stroke" compact :quick="strokeQuick" :model-value="str('strokeColor')" :canvas-background="bg" :allow-transparent="false"
                @pick="(c) => ctl.setStyle({ strokeColor: c })" @edit-swatch="(i, c) => ctl.setQuickColor(strokeSet, i, c)" />
      <span v-if="has('strokeColor') && has('strokeWidth')" class="vsep" />
      <OptionRow v-if="has('strokeWidth')" class="widths" name="Stroke width" :options="widthOptions" :model-value="val('strokeWidth')" @pick="(v) => ctl.setStyle({ strokeWidth: v })" />
      <button v-if="!zen" class="icon-btn mini" type="button" aria-label="Expand properties" :aria-expanded="false" data-testid="props-collapse" @click="toggleCollapsed">
        <Icon name="sliders" :size="18" />
      </button>
    </div>

    <template v-else>
      <header class="head">
        <strong>{{ title }}</strong>
        <button class="icon-btn mini" type="button" aria-label="Minimize tool options" title="Minimize" :aria-expanded="true" data-testid="props-collapse" @click="toggleCollapsed">
          <Icon name="minus" :size="18" />
        </button>
      </header>

      <div class="body">
        <!-- tool-only options -->
        <section v-if="!hasSel && tool === 'shape'" data-testid="sec-shape-kind">
          <label>Shape</label>
          <div class="kinds">
            <button v-for="k in DRAWABLE_SHAPE_KINDS" :key="k" type="button" class="opt" :class="{ on: opts?.shape.kind === k }" :aria-label="k" :aria-pressed="opts?.shape.kind === k"
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
        <p v-if="!hasSel && tool === 'frame'" class="hint muted">Drag to draw a frame. Whatever lies inside moves with it and is clipped to it. Double-tap the name to rename; "Remove frame" frees the content again.</p>

        <!-- Excalidraw order -->
        <section v-if="has('strokeColor')">
          <label>Stroke</label>
          <ColorRow label="Stroke" name="stroke" :quick="strokeQuick" :model-value="str('strokeColor')" :canvas-background="bg" :allow-transparent="false"
                    @pick="(c) => ctl.setStyle({ strokeColor: c })" @edit-swatch="(i, c) => ctl.setQuickColor(strokeSet, i, c)" />
        </section>
        <section v-if="has('backgroundColor')">
          <label>Background</label>
          <ColorRow label="Background" name="background" :quick="quick.background" :model-value="str('backgroundColor')" :canvas-background="bg"
                    @pick="(c) => ctl.setStyle({ backgroundColor: c })" @edit-swatch="(i, c) => ctl.setQuickColor('background', i, c)" />
        </section>
        <section v-if="showFill" data-testid="sec-fillStyle">
          <label>Fill</label>
          <OptionRow name="Fill style" :options="FILLS" :model-value="val('fillStyle')" @pick="(v) => ctl.setStyle({ fillStyle: v })" />
        </section>
        <section v-if="has('strokeWidth')" data-testid="sec-strokeWidth">
          <label>Stroke width</label>
          <OptionRow name="Stroke width" :options="widthOptions" :model-value="val('strokeWidth')" @pick="(v) => ctl.setStyle({ strokeWidth: v })" />
        </section>
        <section v-if="has('cap')" data-testid="sec-cap">
          <label>Edges</label>
          <OptionRow name="Edges" :options="CAPS" :model-value="val('cap')" @pick="(v) => ctl.setStyle({ cap: v })" />
        </section>
        <section v-if="has('strokeStyle')" data-testid="sec-strokeStyle">
          <label>Stroke style</label>
          <OptionRow name="Stroke style" :options="STROKE_STYLES" :model-value="val('strokeStyle')" @pick="(v) => ctl.setStyle({ strokeStyle: v })" />
        </section>
        <section v-if="has('roundness')" data-testid="sec-roundness">
          <label>Corners</label>
          <OptionRow name="Corners" :options="CORNERS" :model-value="val('roundness')" @pick="(v) => ctl.setStyle({ roundness: v })" />
        </section>
        <section v-if="has('roughness')" data-testid="sec-roughness">
          <label>Sloppiness</label>
          <OptionRow name="Sloppiness" :options="ROUGH" :model-value="val('roughness')" @pick="(v) => ctl.setStyle({ roughness: v })" />
        </section>
        <section v-if="has('blurMode')" data-testid="sec-blurMode">
          <label>Blur</label>
          <OptionRow name="Blur mode" :options="BLUR_MODES" :model-value="val('blurMode')" @pick="(v) => ctl.setStyle({ blurMode: v })" />
        </section>
        <section v-if="has('blurSize')" data-testid="sec-blurSize">
          <label>{{ val('blurMode') === 'gaussian' ? 'Blur radius' : 'Pixel size' }} <b>{{ val('blurSize') === 'mixed' ? 'mixed' : blurSize }}</b></label>
          <input type="range" min="4" max="64" step="2" :value="blurSize" aria-label="Blur size" data-testid="blur-size" @input="ctl.setStyle({ blurSize: num($event) }, 'blurSize')" />
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
          <div class="opt-row">
            <OptionRow name="Font family" :options="FONTS" :model-value="val('fontFamily')" @pick="(v) => ctl.setStyle({ fontFamily: v })" />
            <Menu :items="moreFonts">
              <template #default="{ open }">
                <button type="button" class="opt" :class="{ on: open || !!customFont }" aria-haspopup="menu" :aria-expanded="open" :aria-label="customFont ? `Font: ${customFont.label}` : 'More fonts'"
                        :title="customFont?.label ?? 'More fonts'" data-testid="font-family-more">
                  <span v-if="customFont" class="aa" :style="{ fontFamily: FONT_FAMILIES[customFont.family] }">Aa</span>
                  <Icon v-else name="more" :size="20" />
                </button>
              </template>
            </Menu>
          </div>
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
          <section v-if="sel.count > 1" data-testid="sec-align">
            <label>Align</label>
            <div v-for="row in ALIGN_ROWS" :key="row.axis" class="opt-row">
              <button v-for="a in row.modes" :key="a.mode" type="button" class="opt" :aria-label="a.label" :title="a.label" :data-testid="`align-${a.mode}`" @click="ctl.alignSelection(a.mode)"><Icon :name="a.icon" :size="20" /></button>
              <button v-if="sel.count > 2" type="button" class="opt" :aria-label="`Distribute ${row.axis}ly`" :title="`Distribute ${row.axis}ly`" :data-testid="`distribute-${row.axis}`"
                      @click="ctl.distributeSelection(row.axis)"><Icon :name="row.distributeIcon" :size="20" /></button>
            </div>
          </section>
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
              <button v-if="sel.frame" class="btn small" data-testid="frame-select-content" @click="ctl.selectFrameContent()"><Icon name="select" :size="18" /> Select content</button>
              <button v-if="sel.frame" class="btn small" data-testid="frame-remove" title="Remove the frame, keep what is inside" @click="ctl.unframeSelection()"><Icon name="frame" :size="18" /> Remove frame</button>
              <button v-if="sel.text" class="opt" aria-label="Copy recognized text" title="Copy text" @click="copy"><Icon name="doc" :size="20" /></button>
              <button class="opt danger" aria-label="Delete" title="Delete" data-testid="delete-selection" @click="e().deleteSelection()"><Icon name="trash" :size="20" /></button>
            </div>
          </section>
        </template>
        <section v-if="!hasSel && (tool === 'pen' || tool === 'highlighter') && opts" class="check-row">
          <label class="check"><input type="checkbox" :checked="opts[tool].pressureSensitive" data-testid="pressure" @change="ctl.setOption(tool, { pressureSensitive: ($event.target as HTMLInputElement).checked })" /> Pressure sensitivity</label>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.props {
  position: absolute; z-index: 21; display: flex; flex-direction: column; left: calc(8px + var(--safe-left)); right: calc(8px + var(--safe-right));
  bottom: calc(66px + var(--safe-bottom)); max-height: 46vh; margin: 0 auto; max-width: 460px; transition: bottom 0.28s ease;
}
/* HUD hidden: the quick bar moves down into the place the toolbar left free */
.props.docked { bottom: calc(8px + var(--safe-bottom)); }
.props.zen { opacity: 0.96; }
.props.compact { width: max-content; max-width: calc(100% - 16px); left: 0; right: 0; }
.quick { display: flex; align-items: center; gap: 6px; padding: 5px 6px; }
.quick :deep(.opt-row) { flex-wrap: nowrap; gap: 2px; }
.quick :deep(.opt) { width: 32px; height: 30px; background: transparent; }
.quick :deep(.opt.on) { background: var(--accent-soft); }
.vsep { width: 1px; height: 22px; background: var(--border); }
.head { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 0 14px; min-height: 36px; }
.head strong { font-size: 13px; }
.mini { width: 32px; height: 32px; }
.body { overflow-y: auto; padding: 2px 14px 12px; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px 16px; overscroll-behavior: contain; }
section { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
section > label { font-size: 12.5px; font-weight: 600; color: var(--muted); display: flex; justify-content: space-between; }
section > label b { color: var(--text); }
.hint { font-size: 12.5px; margin: 0; }
.kinds { display: flex; gap: 4px; flex-wrap: wrap; }
.opt-row { display: flex; flex-wrap: wrap; gap: 6px; }
.opt {
  width: 36px; height: 34px; border-radius: var(--radius); border: 1px solid transparent; background: var(--surface-2); color: var(--text);
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
}
.opt:hover { background: var(--surface-3); }
.opt.on { background: var(--accent-soft); color: var(--accent-strong); border-color: var(--accent); }
.opt.danger { color: var(--danger); }
.heads { display: flex; gap: 6px; }
.head-list { display: flex; gap: 4px; flex-wrap: wrap; padding: 6px; border-radius: var(--radius); background: var(--surface-2); }
.head-list .opt { background: var(--surface); width: 32px; }
.aa { font-size: 15px; line-height: 1; }
.scale { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-top: -4px; }
.check { display: flex; align-items: center; justify-content: flex-start !important; gap: 8px; font-size: 14px; color: var(--text) !important; font-weight: 500 !important; }
.check input { width: 20px; height: 20px; accent-color: var(--accent); }
.actions .btn { min-height: 34px; }
</style>
