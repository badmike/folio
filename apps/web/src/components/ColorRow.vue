<script setup lang="ts">
import { adaptColor } from '@folio/document'
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { sameColor } from '../color-ui'
import ColorPicker from './ColorPicker.vue'

/**
 * Quick swatches + divider + current-colour button that opens the colour picker (Excalidraw
 * "Stroke"/"Background" rows). A long press (or right click) on a quick swatch opens the picker
 * to change that swatch: the row is per notebook.
 */
const props = withDefaults(defineProps<{
  label: string
  /** Stable id used for test ids / aria ("stroke" | "background"). */
  name: string
  quick: readonly string[]
  modelValue: string | 'mixed' | undefined
  canvasBackground: string
  allowTransparent?: boolean
  /** Compact: swatches only, no current-colour button. */
  compact?: boolean
}>(), { allowTransparent: true, compact: false })
const emit = defineEmits<{ (e: 'pick', v: string): void; (e: 'editSwatch', index: number, color: string): void }>()

const LONG_PRESS_MS = 450
const open = ref(false)
/** Index of the quick swatch being edited, or null when the picker edits the current colour. */
const editing = ref<number | null>(null)
const btn = ref<HTMLElement | null>(null)
const swatches = ref<HTMLElement[]>([])
const pos = ref<{ left: number; top: number } | null>(null)
const cur = computed(() => (props.modelValue && props.modelValue !== 'mixed' ? props.modelValue : ''))
const show = (c: string) => adaptColor(c, props.canvasBackground)
const pickerValue = computed(() => (editing.value === null ? cur.value : props.quick[editing.value]))
const pickerTitle = computed(() => (editing.value === null ? `${props.label} colors` : `Change swatch ${editing.value + 1}`))

async function openAt(anchor: HTMLElement | null, index: number | null) {
  editing.value = index
  open.value = true
  await nextTick()
  const panel = anchor?.closest('.props') as HTMLElement | null
  const r = panel?.getBoundingClientRect()
  const narrow = window.innerWidth < 720 || window.matchMedia?.('(pointer: coarse)').matches
  if (!r || narrow || !anchor) { pos.value = null; return }
  pos.value = { left: r.right + 8, top: Math.max(8, Math.min(anchor.getBoundingClientRect().top - 40, window.innerHeight - 400)) }
}
function toggle() {
  if (open.value && editing.value === null) { open.value = false; return }
  void openAt(btn.value, null)
}
function onPicked(c: string) {
  if (editing.value !== null) emit('editSwatch', editing.value, c)
  emit('pick', c)
}

// long press on a quick swatch (a plain click / tap applies the colour)
let timer: ReturnType<typeof setTimeout> | undefined
let longPressed = false
function down(i: number) {
  clearTimeout(timer)
  longPressed = false
  timer = setTimeout(() => { longPressed = true; void openAt(swatches.value[i] ?? null, i) }, LONG_PRESS_MS)
}
function cancel() { clearTimeout(timer) }
function click(i: number) {
  clearTimeout(timer)
  if (longPressed) { longPressed = false; return }
  emit('pick', props.quick[i])
}
function context(i: number, e: Event) { e.preventDefault(); cancel(); longPressed = true; void openAt(swatches.value[i] ?? null, i) }
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="row" :data-testid="`sec-${name}`">
    <div class="swatches" role="group" :aria-label="`${label} colors`">
      <button
        v-for="(c, i) in quick" :key="i" ref="swatches" type="button" class="sw" :class="{ on: sameColor(c, cur), checker: c === 'transparent' }"
        :style="c === 'transparent' ? undefined : { background: show(c) }"
        :aria-label="`${label} ${c === 'transparent' ? 'transparent' : c}`" :aria-pressed="sameColor(c, cur)" :data-testid="`${name}-quick-${c}`"
        title="Tap to use, hold to change"
        @pointerdown="down(i)" @pointerup="cancel" @pointerleave="cancel" @pointercancel="cancel" @contextmenu="context(i, $event)" @click="click(i)"
      />
      <template v-if="!compact">
        <span class="div" aria-hidden="true" />
        <button
          ref="btn" type="button" class="sw current" data-picker-anchor :class="{ mixed: modelValue === 'mixed', checker: cur === 'transparent', open: open && editing === null }"
          :style="cur && cur !== 'transparent' ? { background: show(cur) } : undefined"
          :aria-label="`${label} color picker`" :aria-expanded="open" aria-haspopup="dialog" :data-testid="`${name}-color-btn`" @click="toggle"
        />
      </template>
    </div>
    <Teleport to="body">
      <div v-if="open" class="pop" :class="{ sheet: !pos }" :style="pos ? { left: pos.left + 'px', top: pos.top + 'px' } : undefined">
        <ColorPicker
          :model-value="pickerValue" :background="canvasBackground" :allow-transparent="allowTransparent" :title="pickerTitle"
          @update:model-value="onPicked" @close="open = false"
        />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.swatches { display: flex; align-items: center; gap: 4px; flex-wrap: nowrap; }
.sw { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border); padding: 0; flex: none; touch-action: none; }
.sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sw.on { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent); }
.sw.checker { background: repeating-conic-gradient(#c9ced6 0 25%, transparent 0 50%) 0 0 / 10px 10px, #fff; }
.sw.mixed { background: linear-gradient(135deg, #e03131 0 33%, #2f9e44 33% 66%, #1971c2 66%); }
.sw.current { margin-left: 2px; }
.sw.current.open { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent); }
.div { width: 1px; height: 24px; background: var(--border); margin: 0 4px; }
.pop { position: fixed; z-index: 1200; }
.pop.sheet { pointer-events: none; left: 0; right: 0; bottom: calc(8px + var(--safe-bottom)); display: flex; justify-content: center; }
.pop.sheet :deep(.picker) { pointer-events: auto; width: min(340px, calc(100vw - 16px)); }
</style>
