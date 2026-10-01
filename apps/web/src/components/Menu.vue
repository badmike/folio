<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, type StyleValue } from 'vue'
import Icon from './Icon.vue'

export interface MenuItem {
  label?: string
  icon?: string
  action?: () => void
  danger?: boolean
  disabled?: boolean
  divider?: boolean
  /** Renders a checkbox that mirrors this value. */
  checked?: boolean
  /** Marks the current choice of a list (e.g. the selected font). */
  active?: boolean
  /** Font the label is drawn in (font lists). */
  fontFamily?: string
  /** Opens a submenu next to the item instead of running an action (one level). */
  children?: MenuItem[]
}

const props = withDefaults(defineProps<{ items: MenuItem[]; align?: 'left' | 'right'; up?: boolean }>(), { align: 'left', up: false })
const emit = defineEmits<{ (e: 'open'): void }>()

const open = ref(false)
const trigger = ref<HTMLElement | null>(null)
const root = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0, bottom: 0, up: false })
/** The open submenu: index of its parent item and where its panel goes. */
const sub = ref<{ index: number; left: number; top: number } | null>(null)

const levels = computed<{ items: MenuItem[]; style: StyleValue }[]>(() => {
  const p = pos.value
  const main = { items: props.items, style: { left: `${p.left}px`, ...(p.up ? { bottom: `${p.bottom}px` } : { top: `${p.top}px` }) } }
  const s = sub.value
  const children = s && props.items[s.index]?.children
  return children ? [main, { items: children, style: { left: `${s.left}px`, top: `${s.top}px` } }] : [main]
})

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
  const m = root.value?.firstElementChild?.getBoundingClientRect()
  if (!t || !m) return
  const vw = window.innerWidth, vh = window.innerHeight
  let left = props.align === 'right' ? t.right - m.width : t.left
  left = Math.max(8, Math.min(left, vw - m.width - 8))
  const up = props.up || (t.bottom + m.height + 8 > vh && t.top > m.height + 8)
  pos.value = { left, top: t.bottom + 6, bottom: vh - t.top + 6, up }
}
/** Submenu beside its parent item: right of it, left when there is no room, always inside the viewport. */
async function openSub(index: number, item: HTMLElement) {
  const r = item.getBoundingClientRect()
  sub.value = { index, left: r.right + 4, top: r.top - 4 }
  await nextTick()
  const m = root.value?.children[1]?.getBoundingClientRect()
  if (!m || sub.value?.index !== index) return
  const vw = window.innerWidth, vh = window.innerHeight
  const left = r.right + 4 + m.width <= vw - 8 ? r.right + 4 : Math.max(8, r.left - m.width - 4)
  sub.value = { index, left, top: Math.max(8, Math.min(r.top - 4, vh - m.height - 8)) }
}
function close() {
  open.value = false
  sub.value = null
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('keydown', onKey, true)
}
function onOutside(e: Event) {
  const n = e.target as Node
  if (root.value?.contains(n) || trigger.value?.contains(n)) return
  close()
}
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close() }
function run(it: MenuItem, index: number, e: MouseEvent) {
  if (it.disabled) return
  if (it.children) {
    // never toggles shut: a mouse has already opened it by hovering when the click arrives
    if (sub.value?.index !== index) void openSub(index, e.currentTarget as HTMLElement)
    return
  }
  close()
  it.action?.()
}
/** With a mouse the submenu follows the pointer; touch and pen open it with a tap. */
function hover(it: MenuItem, level: number, index: number, e: PointerEvent) {
  if (e.pointerType !== 'mouse' || level > 0 || it.disabled) return
  if (!it.children) sub.value = null
  else if (sub.value?.index !== index) void openSub(index, e.currentTarget as HTMLElement)
}
onBeforeUnmount(close)
</script>

<template>
  <span ref="trigger" class="menu-trigger" @click.stop="toggle">
    <slot :open="open" />
  </span>
  <Teleport to="body">
    <div v-if="open" ref="root" @click.stop>
      <div v-for="(lv, level) in levels" :key="level" class="menu panel floating" role="menu" :style="lv.style">
        <div v-if="level === 0 && $slots.header" class="header"><slot name="header" /></div>
        <template v-for="(it, i) in lv.items" :key="i">
          <div v-if="it.divider" class="divider" />
          <button
            v-else class="item" :class="{ danger: it.danger, active: it.active, open: level === 0 && sub?.index === i }" :disabled="it.disabled"
            :role="it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'" :aria-checked="it.checked" :aria-haspopup="it.children ? 'menu' : undefined"
            :aria-expanded="it.children ? sub?.index === i : undefined" @click="run(it, i, $event)" @pointerenter="hover(it, level, i, $event)"
          >
            <Icon v-if="it.icon" :name="it.icon" :size="16" />
            <span class="lbl" :style="{ fontFamily: it.fontFamily }">{{ it.label }}</span>
            <span v-if="it.checked !== undefined" class="box" :class="{ checked: it.checked }"><Icon v-if="it.checked" name="check" :size="12" /></span>
            <Icon v-if="it.children" name="right" :size="14" />
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.menu-trigger { display: inline-flex; }
.menu { position: fixed; z-index: 1000; min-width: 180px; padding: 4px; display: flex; flex-direction: column; font-size: 13.5px; }
.header { border-bottom: 1px solid var(--border); margin: 0 0 4px; }
.item { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 10px; border: 0; background: transparent; border-radius: 6px; text-align: left; }
.item:hover:not(:disabled), .item.open { background: var(--surface-2); }
.item.active { background: var(--accent-soft); color: var(--accent-strong); }
.item:disabled { opacity: 0.4; }
.item.danger { color: var(--danger); }
.lbl { flex: 1; }
.box { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; border: 1.5px solid var(--border-strong); }
.box.checked { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.divider { height: 1px; background: var(--border); margin: 4px 6px; }
</style>
