<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import Icon from './Icon.vue'

export interface MenuItem {
  label?: string
  icon?: string
  action?: () => void
  danger?: boolean
  disabled?: boolean
  divider?: boolean
  /** Shows a check mark. */
  checked?: boolean
}

const props = withDefaults(defineProps<{ items: MenuItem[]; align?: 'left' | 'right'; up?: boolean }>(), { align: 'left', up: false })
const emit = defineEmits<{ (e: 'open'): void }>()

const open = ref(false)
const trigger = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0, bottom: 0, up: false })

async function toggle() {
  if (open.value) return close()
  open.value = true
  emit('open')
  await nextTick()
  place()
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('keydown', onKey, true)
}
function place() {
  const t = trigger.value?.getBoundingClientRect()
  const m = menu.value?.getBoundingClientRect()
  if (!t || !m) return
  const vw = window.innerWidth, vh = window.innerHeight
  let left = props.align === 'right' ? t.right - m.width : t.left
  left = Math.max(8, Math.min(left, vw - m.width - 8))
  const up = props.up || (t.bottom + m.height + 8 > vh && t.top > m.height + 8)
  pos.value = { left, top: t.bottom + 6, bottom: vh - t.top + 6, up }
}
function close() {
  open.value = false
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('keydown', onKey, true)
}
function onOutside(e: Event) {
  const n = e.target as Node
  if (menu.value?.contains(n) || trigger.value?.contains(n)) return
  close()
}
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close() }
function run(it: MenuItem) {
  if (it.disabled) return
  close()
  it.action?.()
}
onBeforeUnmount(close)
</script>

<template>
  <span ref="trigger" class="menu-trigger" @click.stop="toggle">
    <slot :open="open" />
  </span>
  <Teleport to="body">
    <div v-if="open" ref="menu" class="menu panel floating" role="menu" @click.stop
         :style="{ left: pos.left + 'px', ...(pos.up ? { bottom: pos.bottom + 'px' } : { top: pos.top + 'px' }) }">
      <div v-if="$slots.header" class="header"><slot name="header" /></div>
      <template v-for="(it, i) in items" :key="i">
        <div v-if="it.divider" class="divider" />
        <button v-else class="item" :class="{ danger: it.danger }" :disabled="it.disabled" role="menuitem" @click="run(it)">
          <Icon v-if="it.icon" :name="it.icon" :size="18" />
          <span class="lbl">{{ it.label }}</span>
          <Icon v-if="it.checked" name="check" :size="16" />
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.menu-trigger { display: inline-flex; }
.menu { position: fixed; z-index: 1000; min-width: 190px; padding: 6px; display: flex; flex-direction: column; }
.header { border-bottom: 1px solid var(--border); margin: 0 0 4px; }
.item { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border: 0; background: transparent; border-radius: 6px; text-align: left; }
.item:hover:not(:disabled) { background: var(--surface-2); }
.item:disabled { opacity: 0.4; }
.item.danger { color: var(--danger); }
.lbl { flex: 1; }
.divider { height: 1px; background: var(--border); margin: 4px 6px; }
</style>
