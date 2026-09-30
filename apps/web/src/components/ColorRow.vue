<script setup lang="ts">
import { adaptColor } from '@folio/document'
import { computed, nextTick, ref } from 'vue'
import { sameColor } from '../color-ui'
import ColorPicker from './ColorPicker.vue'

/** Quick swatches + divider + current-colour button that opens the colour picker (Excalidraw "Stroke"/"Background" rows). */
const props = withDefaults(defineProps<{
  label: string
  /** Stable id used for test ids / aria ("stroke" | "background"). */
  name: string
  quick: readonly string[]
  modelValue: string | 'mixed' | undefined
  canvasBackground: string
  allowTransparent?: boolean
}>(), { allowTransparent: true })
const emit = defineEmits<{ (e: 'pick', v: string): void }>()

const open = ref(false)
const btn = ref<HTMLElement | null>(null)
const pos = ref<{ left: number; top: number } | null>(null)
const cur = computed(() => (props.modelValue && props.modelValue !== 'mixed' ? props.modelValue : ''))
const show = (c: string) => adaptColor(c, props.canvasBackground)

async function toggle() {
  open.value = !open.value
  if (!open.value) return
  await nextTick()
  const panel = btn.value?.closest('.props') as HTMLElement | null
  const r = panel?.getBoundingClientRect()
  const narrow = window.innerWidth < 720 || window.matchMedia?.('(pointer: coarse)').matches
  if (!r || narrow) { pos.value = null; return }
  pos.value = { left: r.right + 8, top: Math.max(8, Math.min(btn.value!.getBoundingClientRect().top - 40, window.innerHeight - 400)) }
}
function pick(c: string) { emit('pick', c) }
</script>

<template>
  <div class="row" :data-testid="`sec-${name}`">
    <div class="swatches" role="group" :aria-label="`${label} colors`">
      <button
        v-for="c in quick" :key="c" type="button" class="sw" :class="{ on: sameColor(c, cur), checker: c === 'transparent' }"
        :style="c === 'transparent' ? undefined : { background: show(c) }"
        :aria-label="`${label} ${c === 'transparent' ? 'transparent' : c}`" :aria-pressed="sameColor(c, cur)" :data-testid="`${name}-quick-${c}`"
        @click="pick(c)"
      />
      <span class="div" aria-hidden="true" />
      <button
        ref="btn" type="button" class="sw current" data-picker-anchor :class="{ mixed: modelValue === 'mixed', checker: cur === 'transparent', open }"
        :style="cur && cur !== 'transparent' ? { background: show(cur) } : undefined"
        :aria-label="`${label} color picker`" :aria-expanded="open" aria-haspopup="dialog" :data-testid="`${name}-color-btn`" @click="toggle"
      />
    </div>
    <Teleport to="body">
      <div v-if="open" class="pop" :class="{ sheet: !pos }" :style="pos ? { left: pos.left + 'px', top: pos.top + 'px' } : undefined">
        <ColorPicker
          :model-value="cur" :background="canvasBackground" :allow-transparent="allowTransparent" :title="`${label} colors`"
          @update:model-value="pick" @close="open = false"
        />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.swatches { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sw { width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border); padding: 0; flex: none; }
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
