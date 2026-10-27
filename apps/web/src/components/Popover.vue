<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

/**
 * A panel that opens below its trigger (above when there is no room), teleported to the body.
 * Closes on a pointer-down outside and on Esc; Esc does not reach a surrounding modal.
 */
const props = withDefaults(defineProps<{ align?: 'left' | 'right'; disabled?: boolean }>(), { align: 'left', disabled: false })
const open = defineModel<boolean>('open', { default: false })

const trigger = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0 })
/** Content can grow after opening (lazy data), so the panel is placed again whenever its size changes. */
const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place())

function toggle() {
  if (!props.disabled) open.value = !open.value
}
function place() {
  const t = trigger.value?.getBoundingClientRect()
  const p = panel.value?.getBoundingClientRect()
  if (!t || !p) return
  const vw = window.innerWidth, vh = window.innerHeight
  const left = Math.max(8, Math.min(props.align === 'right' ? t.right - p.width : t.left, vw - p.width - 8))
  const below = t.bottom + 6 + p.height <= vh - 8 || t.top < p.height + 14
  pos.value = { left, top: below ? t.bottom + 6 : t.top - p.height - 6 }
}
function onOutside(e: Event) {
  const n = e.target as Node
  if (!panel.value?.contains(n) && !trigger.value?.contains(n)) open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  open.value = false
}
function listen(on: boolean) {
  if (on) {
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
  } else {
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
  }
}
watch(open, async (v) => {
  listen(v)
  resize?.disconnect()
  if (!v) return
  await nextTick()
  place()
  if (panel.value) resize?.observe(panel.value)
})
onBeforeUnmount(() => {
  listen(false)
  resize?.disconnect()
})
</script>

<template>
  <span ref="trigger" class="popover-trigger" @click="toggle">
    <slot name="trigger" :open="open" />
  </span>
  <Teleport to="body">
    <div v-if="open" ref="panel" class="popover panel floating" :style="{ left: `${pos.left}px`, top: `${pos.top}px` }">
      <slot :close="() => (open = false)" />
    </div>
  </Teleport>
</template>

<style scoped>
.popover-trigger { display: inline-flex; }
.popover { position: fixed; z-index: 1000; }
</style>
