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
    <h4>Background of this page</h4>

    <div class="field">
      <span class="lbl">Paper</span>
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

    <div class="field">
      <span class="lbl">Pattern</span>
      <div class="seg">
        <button v-for="p in PATTERNS" :key="p.v" :class="{ on: bg.pattern === p.v }" :data-testid="`bg-${p.v}`" @click="ctl.setBackground({ pattern: p.v })">{{ p.label }}</button>
      </div>
    </div>

    <template v-if="patterned">
      <label class="slider"><span>Spacing</span>
        <input type="range" min="12" max="96" step="2" :value="bg.spacing" aria-label="Spacing" @input="ctl.setBackground({ spacing: num($event) })" />
        <b>{{ bg.spacing }}</b></label>
      <label class="slider"><span>Line opacity</span>
        <input type="range" min="0.1" max="1" step="0.05" :value="bg.opacity" aria-label="Line opacity" @input="ctl.setBackground({ opacity: num($event) })" />
        <b>{{ Math.round(bg.opacity * 100) }}%</b></label>

      <div class="field">
        <span class="lbl">Line colour</span>
        <div class="row">
          <button type="button" class="chip big" :class="{ on: lineAuto }" data-testid="line-auto" :aria-pressed="lineAuto" @click="ctl.setBackground({ lineColor: defaultLineColor(bg.color) })">Auto</button>
          <button type="button" class="sw line" data-picker-anchor :class="{ on: !lineAuto }" :style="{ background: bg.lineColor }" aria-label="Custom line colour" data-testid="line-custom" @click="pickLine = !pickLine" />
        </div>
        <ColorPicker v-if="pickLine" class="inline-picker" :model-value="bg.lineColor" :background="bg.color" :allow-transparent="false" title="Line colour"
                     @update:model-value="(c) => ctl.setBackground({ lineColor: c })" @close="pickLine = false" />
      </div>

      <div class="field">
        <span class="lbl">Scaling</span>
        <div class="seg" role="radiogroup" aria-label="Scaling">
          <button role="radio" :aria-checked="scaling === 'fixed'" :class="{ on: scaling === 'fixed' }" data-testid="bg-scaling-fixed" @click="ctl.setBackground({ scaling: 'fixed' })">Fixed</button>
          <button role="radio" :aria-checked="scaling === 'dynamic'" :class="{ on: scaling === 'dynamic' }" data-testid="bg-scaling-dynamic" @click="ctl.setBackground({ scaling: 'dynamic' })">Dynamic</button>
        </div>
        <span class="hint muted">{{ scaling === 'dynamic' ? 'Dynamic: grid adapts to zoom' : 'Fixed: spacing stays constant on the page' }}</span>
      </div>

      <div v-if="scaling === 'dynamic'" class="field">
        <span class="lbl">Subdivisions</span>
        <div class="seg" role="radiogroup" aria-label="Subdivisions">
          <button v-for="n in SUBDIVISIONS" :key="n" role="radio" :aria-checked="(bg.subdivisions ?? 5) === n" :class="{ on: (bg.subdivisions ?? 5) === n }" :data-testid="`bg-sub-${n}`"
                  @click="ctl.setBackground({ subdivisions: n })">{{ n }}</button>
        </div>
      </div>
      <div v-if="hasMajor" class="field">
        <span class="lbl">Emphasise every Nth line</span>
        <div class="seg" role="radiogroup" aria-label="Emphasise every Nth line">
          <button v-for="n in MAJOR" :key="n" role="radio" :aria-checked="(bg.majorEvery ?? 0) === n" :class="{ on: (bg.majorEvery ?? 0) === n }" :data-testid="`bg-major-${n}`"
                  @click="ctl.setBackground({ majorEvery: n })">{{ n === 0 ? 'Off' : n }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bg { margin-top: 20px; display: flex; flex-direction: column; gap: 12px; }
h4 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.field { margin: 0; gap: 6px; }
.lbl { font-size: 13px; color: var(--muted); font-weight: 550; }
.hint { font-size: 12.5px; }
.swatches { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sw { width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border); padding: 0; }
.sw.dark { border-color: #555; }
.sw.on { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent); }
.sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sw.custom { background: conic-gradient(red, yellow, lime, aqua, blue, magenta, red); }
.div { width: 1px; height: 24px; background: var(--border); margin: 0 2px; }
.inline-picker { width: 100%; box-shadow: none; }
.slider { display: grid; grid-template-columns: 84px 1fr 42px; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
.slider b { color: var(--text); text-align: right; font-size: 12.5px; }
.chip.big { min-height: 34px; padding: 0 14px; font-size: 14px; border: 1px solid var(--border); }
.seg { flex-wrap: wrap; }
</style>
