<script setup lang="ts">
import { PALETTE, adaptColor } from '@folio/document'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { GRID_KEYS, colorForHue, normalizeHex, sameColor, shadesFor } from '../color-ui'
import Icon from './Icon.vue'

/**
 * Excalidraw-style colour picker popover: "Colors" hue grid (keyboard letters), "Shades" row (keys 1-5) and
 * a hex code input with an optional eyedropper. Swatches are previewed adapted to the page background, but
 * the emitted value is always the canonical (stored) colour.
 */
const props = withDefaults(defineProps<{
  modelValue: string
  /** Page background the swatches are previewed on. */
  background?: string
  /** 'stroke' colours cannot be transparent. */
  allowTransparent?: boolean
  title?: string
}>(), { background: '#ffffff', allowTransparent: true, title: 'Colors' })
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'close'): void }>()

const root = ref<HTMLElement | null>(null)
const hex = ref('')
const hexError = ref(false)
const supportsEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window
const shades = computed(() => shadesFor(props.modelValue))
const show = (c: string) => adaptColor(c, props.background)
const isAdapted = (c: string) => c !== 'transparent' && show(c).toLowerCase() !== c.toLowerCase()

function syncHex() {
  hex.value = props.modelValue === 'transparent' ? '' : props.modelValue.replace(/^#/, '')
  hexError.value = false
}
watch(() => props.modelValue, syncHex, { immediate: true })

function pick(c: string) {
  if (c === 'transparent' && !props.allowTransparent) return
  emit('update:modelValue', c)
}
function applyHex() {
  if (!hex.value.trim() && props.allowTransparent) return void (hexError.value = false)
  const n = normalizeHex(hex.value)
  if (!n) { hexError.value = true; return }
  hexError.value = false
  if (!sameColor(n, props.modelValue)) pick(n)
}
function onHexBlur() {
  if (!hexError.value && normalizeHex(hex.value)) applyHex()
  else if (hex.value.trim()) hexError.value = !normalizeHex(hex.value)
}
async function eyedrop() {
  try {
    const ED = (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper
    const r = await new ED().open()
    const n = normalizeHex(r.sRGBHex)
    if (n) pick(n)
  } catch { /* cancelled */ }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); emit('close'); return }
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') || e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key.toLowerCase()
  const gi = (GRID_KEYS as readonly string[]).indexOf(k)
  if (gi >= 0) {
    e.stopPropagation(); e.preventDefault()
    const c = colorForHue(gi, props.modelValue)
    pick(c)
    return
  }
  if (/^[1-5]$/.test(k) && shades.value.length) {
    e.stopPropagation(); e.preventDefault()
    pick(shades.value[Number(k) - 1])
  }
}
function onOutside(e: Event) {
  const n = e.target as Node
  if (root.value && !root.value.contains(n) && !(n as HTMLElement).closest?.('[data-picker-anchor]')) emit('close')
}
onMounted(() => {
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onOutside, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true)
  document.removeEventListener('pointerdown', onOutside, true)
})
</script>

<template>
  <div ref="root" class="picker panel" role="dialog" :aria-label="title" data-testid="color-picker" @pointerdown.stop>
    <h4>{{ title }}</h4>
    <div class="grid" role="listbox" aria-label="Colors">
      <button
        v-for="(h, i) in PALETTE" :key="h.name" class="sw" role="option" type="button"
        :class="{ on: sameColor(h.shades[3], modelValue), checker: h.name === 'transparent' }"
        :style="h.name === 'transparent' ? undefined : { background: show(h.shades[3]) }"
        :disabled="h.name === 'transparent' && !allowTransparent"
        :aria-selected="sameColor(h.shades[3], modelValue)"
        :aria-label="`${h.name}, key ${GRID_KEYS[i]}`" :title="h.name" :data-testid="`hue-${h.name}`"
        @click="pick(colorForHue(i, modelValue))"
      >
        <span class="key" :class="{ lightbg: h.name !== 'black' }">{{ GRID_KEYS[i] }}</span>
        <span v-if="isAdapted(h.shades[3])" class="adapted" aria-hidden="true" />
      </button>
    </div>

    <h4>Shades</h4>
    <div v-if="shades.length" class="shades" role="listbox" aria-label="Shades">
      <button
        v-for="(s, i) in shades" :key="i" class="sw" role="option" type="button" :class="{ on: sameColor(s, modelValue) }"
        :style="{ background: show(s) }" :aria-selected="sameColor(s, modelValue)" :aria-label="`Shade ${i + 1}, key ${i + 1}`"
        :data-testid="`shade-${i + 1}`" @click="pick(s)"
      >
        <span class="key lightbg">{{ i + 1 }}</span>
      </button>
    </div>
    <p v-else class="none" data-testid="no-shades">No shades available for this color</p>

    <h4>Hex code</h4>
    <div class="hexrow" :class="{ bad: hexError }">
      <span class="hash" aria-hidden="true">#</span>
      <input
        v-model="hex" class="hex" data-testid="hex-input" aria-label="Hex code" spellcheck="false" autocomplete="off"
        :aria-invalid="hexError" maxlength="9"
        @keydown.enter.prevent="applyHex" @blur="onHexBlur" @input="hexError = false"
      />
      <button v-if="supportsEyeDropper" class="eye" type="button" aria-label="Pick colour from screen" title="Eyedropper" data-testid="eyedropper" @click="eyedrop">
        <Icon name="eyedropper" :size="18" />
      </button>
    </div>
    <p v-if="hexError" class="err" role="alert">Enter a hex colour like 1e1e1e or f00</p>
  </div>
</template>

<style scoped>
.picker { width: 232px; padding: 12px 14px 14px; z-index: 60; }
h4 { margin: 10px 0 6px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
h4:first-child { margin-top: 0; }
.grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.shades { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.sw {
  position: relative; aspect-ratio: 1; min-height: 34px; border-radius: 8px; padding: 0; border: 1px solid var(--border);
  display: flex; align-items: flex-end; justify-content: flex-end; overflow: hidden;
}
.sw:focus-visible, .hex:focus-visible, .eye:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sw.on { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent); }
.sw:disabled { opacity: 0.35; cursor: not-allowed; }
.sw.checker { background: repeating-conic-gradient(#c9ced6 0 25%, transparent 0 50%) 0 0 / 10px 10px, #fff; }
.key { font-size: 11px; line-height: 1; padding: 2px 4px; color: #fff; text-shadow: 0 0 2px rgba(0, 0, 0, 0.7); }
.key.lightbg { color: #1e1e1e; text-shadow: 0 0 2px rgba(255, 255, 255, 0.7); }
.adapted { position: absolute; top: 3px; left: 3px; width: 6px; height: 6px; border-radius: 50%; background: var(--surface); box-shadow: 0 0 0 1px var(--muted); }
.none { margin: 4px 0 2px; font-size: 13px; color: var(--muted); text-align: center; padding: 6px 0; }
.hexrow { display: flex; align-items: center; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); min-height: 40px; }
.hexrow:focus-within { border-color: var(--accent); }
.hexrow.bad { border-color: var(--danger); }
.hash { padding: 0 8px 0 12px; color: var(--muted); font-family: ui-monospace, monospace; }
.hex { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; font-family: ui-monospace, monospace; letter-spacing: 0.03em; height: 38px; }
.eye { border: 0; border-left: 1px solid var(--border); background: transparent; width: 40px; height: 38px; display: flex; align-items: center; justify-content: center; color: var(--text); }
.err { color: var(--danger); font-size: 12px; margin: 4px 0 0; }
</style>
