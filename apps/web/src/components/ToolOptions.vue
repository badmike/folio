<script setup lang="ts">
import type { FontFamily, ShapeKind } from '@folio/document'
import { computed, inject } from 'vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import Icon from './Icon.vue'

const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const tool = ctl.tool
const o = computed(() => ctl.options.value)

const PALETTE = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#0c8599', '#868e96']
const HIGHLIGHT = ['#ffd43b', '#8ce99a', '#faa2c1', '#74c0fc', '#ffa94d', '#d0bfff']
const FILLS = ['', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#eebefa']
const KINDS: ShapeKind[] = ['rectangle', 'ellipse', 'triangle', 'diamond', 'line']
const FONTS: { v: FontFamily; label: string }[] = [{ v: 'hand', label: 'Hand' }, { v: 'sans', label: 'Sans' }, { v: 'mono', label: 'Mono' }]

const num = (e: Event) => Number((e.target as HTMLInputElement).value)
</script>

<template>
  <div v-if="o" class="opts panel" data-testid="tool-options" @pointerdown.stop>
    <!-- pen / highlighter -->
    <template v-if="tool === 'pen' || tool === 'highlighter'">
      <div class="swatches">
        <button v-for="c in tool === 'pen' ? PALETTE : HIGHLIGHT" :key="c" class="sw" :class="{ on: o[tool].color === c }"
                :style="{ background: c }" :aria-label="`Color ${c}`" @click="ctl.setOption(tool, { color: c })" />
        <input type="color" class="sw custom" :value="o[tool].color" aria-label="Custom color" @input="ctl.setOption(tool, { color: ($event.target as HTMLInputElement).value })" />
      </div>
      <label class="slider"><span>Width</span>
        <input type="range" :min="tool === 'pen' ? 1 : 6" :max="tool === 'pen' ? 16 : 48" step="0.5" :value="o[tool].width" @input="ctl.setOption(tool, { width: num($event) })" />
        <b>{{ o[tool].width }}</b></label>
      <label class="slider"><span>Opacity</span>
        <input type="range" min="0.1" max="1" step="0.05" :value="o[tool].opacity" @input="ctl.setOption(tool, { opacity: num($event) })" />
        <b>{{ Math.round(o[tool].opacity * 100) }}%</b></label>
      <label class="check"><input type="checkbox" :checked="o[tool].pressureSensitive" @change="ctl.setOption(tool, { pressureSensitive: ($event.target as HTMLInputElement).checked })" /> Pressure sensitivity</label>
    </template>

    <!-- eraser -->
    <template v-else-if="tool === 'eraser'">
      <label class="slider"><span>Size</span>
        <input type="range" min="8" max="80" step="2" :value="o.eraser.size" @input="ctl.setOption('eraser', { size: num($event) })" />
        <b>{{ o.eraser.size }}</b></label>
    </template>

    <!-- select -->
    <template v-else-if="tool === 'select'">
      <div class="label">Selection</div>
      <div class="seg">
        <button :class="{ on: o.select.mode === 'auto' }" @click="ctl.setOption('select', { mode: 'auto' })">Auto</button>
        <button :class="{ on: o.select.mode === 'rect' }" @click="ctl.setOption('select', { mode: 'rect' })">Rectangle</button>
        <button :class="{ on: o.select.mode === 'lasso' }" @click="ctl.setOption('select', { mode: 'lasso' })">Lasso</button>
      </div>
    </template>

    <!-- shape -->
    <template v-else-if="tool === 'shape'">
      <div class="kinds">
        <button v-for="k in KINDS" :key="k" class="icon-btn" :class="{ active: o.shape.kind === k }" :aria-label="k" :data-testid="`shape-${k}`" @click="ctl.setOption('shape', { kind: k })"><Icon :name="k" /></button>
      </div>
      <div class="label">Stroke</div>
      <div class="swatches">
        <button v-for="c in PALETTE" :key="c" class="sw" :class="{ on: o.shape.strokeColor === c }" :style="{ background: c }" :aria-label="`Stroke ${c}`" @click="ctl.setOption('shape', { strokeColor: c })" />
      </div>
      <template v-if="o.shape.kind !== 'line'">
        <div class="label">Fill</div>
        <div class="swatches">
          <button v-for="c in FILLS" :key="c || 'none'" class="sw" :class="{ on: (o.shape.fillColor ?? '') === c, none: !c }" :style="{ background: c || 'transparent' }" :aria-label="c ? `Fill ${c}` : 'No fill'" @click="ctl.setOption('shape', { fillColor: c || undefined })" />
        </div>
      </template>
      <label class="slider"><span>Width</span><input type="range" min="1" max="10" step="0.5" :value="o.shape.strokeWidth" @input="ctl.setOption('shape', { strokeWidth: num($event) })" /><b>{{ o.shape.strokeWidth }}</b></label>
      <label class="slider"><span>Sketchy</span><input type="range" min="0" max="3" step="1" :value="o.shape.roughness" @input="ctl.setOption('shape', { roughness: num($event) })" /><b>{{ o.shape.roughness }}</b></label>
      <label class="slider"><span>Opacity</span><input type="range" min="0.1" max="1" step="0.05" :value="o.shape.opacity" @input="ctl.setOption('shape', { opacity: num($event) })" /><b>{{ Math.round(o.shape.opacity * 100) }}%</b></label>
    </template>

    <!-- arrow -->
    <template v-else-if="tool === 'arrow'">
      <div class="swatches">
        <button v-for="c in PALETTE" :key="c" class="sw" :class="{ on: o.arrow.strokeColor === c }" :style="{ background: c }" :aria-label="`Color ${c}`" @click="ctl.setOption('arrow', { strokeColor: c })" />
      </div>
      <label class="slider"><span>Width</span><input type="range" min="1" max="10" step="0.5" :value="o.arrow.strokeWidth" @input="ctl.setOption('arrow', { strokeWidth: num($event) })" /><b>{{ o.arrow.strokeWidth }}</b></label>
      <label class="slider"><span>Sketchy</span><input type="range" min="0" max="3" step="1" :value="o.arrow.roughness" @input="ctl.setOption('arrow', { roughness: num($event) })" /><b>{{ o.arrow.roughness }}</b></label>
      <div class="seg">
        <button :class="{ on: o.arrow.startHead === 'none' && o.arrow.endHead === 'arrow' }" @click="ctl.setOption('arrow', { startHead: 'none', endHead: 'arrow' })">→</button>
        <button :class="{ on: o.arrow.startHead === 'arrow' && o.arrow.endHead === 'arrow' }" @click="ctl.setOption('arrow', { startHead: 'arrow', endHead: 'arrow' })">↔</button>
        <button :class="{ on: o.arrow.startHead === 'none' && o.arrow.endHead === 'none' }" @click="ctl.setOption('arrow', { startHead: 'none', endHead: 'none' })">—</button>
      </div>
    </template>

    <!-- text -->
    <template v-else-if="tool === 'text'">
      <div class="seg">
        <button v-for="f in FONTS" :key="f.v" :class="{ on: o.text.fontFamily === f.v }" @click="ctl.setOption('text', { fontFamily: f.v })">{{ f.label }}</button>
      </div>
      <div class="swatches">
        <button v-for="c in PALETTE" :key="c" class="sw" :class="{ on: o.text.color === c }" :style="{ background: c }" :aria-label="`Color ${c}`" @click="ctl.setOption('text', { color: c })" />
      </div>
      <label class="slider"><span>Size</span><input type="range" min="12" max="96" step="2" :value="o.text.fontSize" @input="ctl.setOption('text', { fontSize: num($event) })" /><b>{{ o.text.fontSize }}</b></label>
    </template>
  </div>
</template>

<style scoped>
.opts { padding: 12px; width: min(320px, calc(100vw - 24px)); display: flex; flex-direction: column; gap: 10px; }
.swatches { display: flex; flex-wrap: wrap; gap: 8px; }
.sw { width: 32px; height: 32px; border-radius: 50%; border: 2px solid var(--border); padding: 0; }
.sw.on { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.sw.none { background-image: linear-gradient(135deg, transparent 45%, var(--danger) 46%, var(--danger) 54%, transparent 55%); }
.sw.custom { padding: 0; overflow: hidden; background: conic-gradient(red, yellow, lime, aqua, blue, magenta, red); }
.sw.custom::-webkit-color-swatch-wrapper { padding: 0; opacity: 0; }
.slider { display: grid; grid-template-columns: 62px 1fr 42px; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
.slider b { color: var(--text); font-weight: 600; text-align: right; font-size: 12.5px; }
.check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.check input { width: 20px; height: 20px; accent-color: var(--accent); }
.kinds { display: flex; gap: 2px; }
.label { margin-bottom: -4px; }
</style>
