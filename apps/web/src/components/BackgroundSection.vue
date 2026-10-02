<script setup lang="ts">
import {
  CANVAS_BACKGROUNDS_DARK, CANVAS_BACKGROUNDS_LIGHT, defaultLineColor, type BackgroundPattern, type Page,
} from '@folio/document'
import { computed, inject, ref } from 'vue'
import { sameColor } from '../color-ui'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import ColorPicker from './ColorPicker.vue'

/** "Background of this page": paper colour presets (light + dark), pattern, spacing, scaling and grid emphasis. */
const props = defineProps<{ page: Page }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const bg = computed(() => props.page.background)
const PATTERNS: { v: BackgroundPattern; label: string }[] = [
  { v: 'blank', label: 'Blank' }, { v: 'ruled', label: 'Ruled' }, { v: 'grid', label: 'Grid' }, { v: 'dot', label: 'Dots' },
]
const SUBDIVISIONS = [2, 4, 5, 10]
const MAJOR = [0, 2, 4, 5, 10]
const scaling = computed(() => bg.value.scaling ?? 'fixed')
const patterned = computed(() => bg.value.pattern !== 'blank')
const hasMajor = computed(() => bg.value.pattern === 'grid' || bg.value.pattern === 'ruled')

/** The line colour is "auto" while it equals the scheme default for the paper (or the legacy default). */
const lineAuto = computed(() => sameColor(bg.value.lineColor, defaultLineColor(bg.value.color)) || sameColor(bg.value.lineColor, '#d0d4da'))
function setPaper(color: string) {
  // automatic line colour follows the paper; a customised one is left alone
  ctl.setBackground(lineAuto.value ? { color, lineColor: defaultLineColor(color) } : { color })
}
const pickPaper = ref(false)
const pickLine = ref(false)
const num = (e: Event) => Number((e.target as HTMLInputElement).value)
</script>

<template>
  <div class="bg" data-testid="background-section">
    <h4>Background</h4>

    <div class="setting stack">
      <span class="name">Paper</span>
      <div class="swatches" role="group" aria-label="Paper colour">
        <button v-for="c in CANVAS_BACKGROUNDS_LIGHT" :key="c" type="button" class="sw" :class="{ on: sameColor(c, bg.color) }" :style="{ background: c }"
                :aria-label="`Light paper ${c}`" :aria-pressed="sameColor(c, bg.color)" :data-testid="`paper-${c}`" @click="setPaper(c)" />
        <span class="div" aria-hidden="true" />
        <button v-for="c in CANVAS_BACKGROUNDS_DARK" :key="c" type="button" class="sw dark" :class="{ on: sameColor(c, bg.color) }" :style="{ background: c }"
                :aria-label="`Dark paper ${c}`" :aria-pressed="sameColor(c, bg.color)" :data-testid="`paper-${c}`" @click="setPaper(c)" />
        <button type="button" class="sw custom" data-picker-anchor aria-label="Custom paper colour" :aria-expanded="pickPaper" data-testid="paper-custom" @click="pickPaper = !pickPaper" />
      </div>
      <ColorPicker v-if="pickPaper" class="inline-picker" :model-value="bg.color" :allow-transparent="false" title="Paper colour" @update:model-value="setPaper" @close="pickPaper = false" />
    </div>

    <div class="setting stack">
      <span class="name">Pattern</span>
      <div class="seg soft fill" role="radiogroup" aria-label="Pattern">
        <button v-for="p in PATTERNS" :key="p.v" :class="{ on: bg.pattern === p.v }" :data-testid="`bg-${p.v}`" @click="ctl.setBackground({ pattern: p.v })">{{ p.label }}</button>
      </div>
    </div>

    <template v-if="patterned">
      <label class="setting stack">
        <span class="name">Spacing <b>{{ bg.spacing }}</b></span>
        <input type="range" min="12" max="96" step="2" :value="bg.spacing" aria-label="Spacing" @input="ctl.setBackground({ spacing: num($event) })" />
      </label>
      <label class="setting stack">
        <span class="name">Line opacity <b>{{ Math.round(bg.opacity * 100) }}%</b></span>
        <input type="range" min="0.1" max="1" step="0.05" :value="bg.opacity" aria-label="Line opacity" @input="ctl.setBackground({ opacity: num($event) })" />
      </label>

      <div class="setting">
        <span class="name">Line colour</span>
        <div class="seg soft" role="group" aria-label="Line colour">
          <button type="button" :class="{ on: lineAuto }" data-testid="line-auto" :aria-pressed="lineAuto" @click="ctl.setBackground({ lineColor: defaultLineColor(bg.color) })">Auto</button>
          <button type="button" class="pick" data-picker-anchor :class="{ on: !lineAuto }" aria-label="Custom line colour" data-testid="line-custom" @click="pickLine = !pickLine">
            <span class="dot" :style="{ background: bg.lineColor }" /> Custom
          </button>
        </div>
      </div>
      <ColorPicker v-if="pickLine" class="inline-picker" :model-value="bg.lineColor" :background="bg.color" :allow-transparent="false" title="Line colour"
                   @update:model-value="(c) => ctl.setBackground({ lineColor: c })" @close="pickLine = false" />

      <div class="setting">
        <div class="text">
          <span class="name">Scaling</span>
          <p>{{ scaling === 'dynamic' ? 'The grid adapts to the zoom level.' : 'Spacing stays the same on the page.' }}</p>
        </div>
        <div class="seg soft" role="radiogroup" aria-label="Scaling">
          <button role="radio" :aria-checked="scaling === 'fixed'" :class="{ on: scaling === 'fixed' }" data-testid="bg-scaling-fixed" @click="ctl.setBackground({ scaling: 'fixed' })">Fixed</button>
          <button role="radio" :aria-checked="scaling === 'dynamic'" :class="{ on: scaling === 'dynamic' }" data-testid="bg-scaling-dynamic" @click="ctl.setBackground({ scaling: 'dynamic' })">Dynamic</button>
        </div>
      </div>

      <div v-if="scaling === 'dynamic'" class="setting">
        <span class="name">Subdivisions</span>
        <div class="seg soft" role="radiogroup" aria-label="Subdivisions">
          <button v-for="n in SUBDIVISIONS" :key="n" role="radio" :aria-checked="(bg.subdivisions ?? 5) === n" :class="{ on: (bg.subdivisions ?? 5) === n }" :data-testid="`bg-sub-${n}`"
                  @click="ctl.setBackground({ subdivisions: n })">{{ n }}</button>
        </div>
      </div>
      <div v-if="hasMajor" class="setting stack">
        <span class="name">Emphasise every nth line</span>
        <div class="seg soft fill" role="radiogroup" aria-label="Emphasise every Nth line">
          <button v-for="n in MAJOR" :key="n" role="radio" :aria-checked="(bg.majorEvery ?? 0) === n" :class="{ on: (bg.majorEvery ?? 0) === n }" :data-testid="`bg-major-${n}`"
                  @click="ctl.setBackground({ majorEvery: n })">{{ n === 0 ? 'Off' : n }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bg { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
h4 { margin: 0 0 2px; padding-left: 10px; font-size: 12px; font-weight: 600; color: var(--muted); }
.setting { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0 12px 10px; border-bottom: 1px solid var(--border); }
.setting:last-child { border-bottom: 0; }
.setting.stack { flex-direction: column; align-items: stretch; gap: 8px; }
.text { min-width: 0; }
.text p { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
.name { display: flex; justify-content: space-between; font-size: 13.5px; font-weight: 600; color: var(--text-strong); }
.name b { font-weight: 500; color: var(--muted); font-variant-numeric: tabular-nums; }
.seg { flex: none; }
.seg.fill { display: flex; }
.seg.fill button { flex: 1; padding: 0 6px; }
.pick { display: inline-flex; align-items: center; gap: 6px; }
.dot { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(127, 127, 127, 0.4); }
.swatches { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sw { width: 28px; height: 28px; border-radius: 7px; border: 1px solid var(--border); padding: 0; }
.sw.dark { border-color: #555; }
.sw.on { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent); }
.sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sw.custom { background: conic-gradient(red, yellow, lime, aqua, blue, magenta, red); }
.div { width: 1px; height: 22px; background: var(--border); margin: 0 2px; }
.inline-picker { width: 100%; box-shadow: none; }
input[type='range'] { height: 22px; }
</style>
