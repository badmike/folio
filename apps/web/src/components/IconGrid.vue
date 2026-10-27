<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { iconLibrary, loadIconLibrary } from '../icon-loader'
import type { IconGroup } from '../icon-library'
import { hasKeyboard } from '../services/input-mode'
import Popover from './Popover.vue'
import SvgIcon from './SvgIcon.vue'

/** Icon picker: a trigger showing the chosen icon and a searchable, grouped grid of Lucide icons. */
const props = defineProps<{ color?: string | null; disabled?: boolean }>()
const selected = defineModel<string | null>()

type Row = { type: 'label'; id: string; title: string } | { type: 'icons'; id: string; icons: string[] }

const COLUMNS = 8
const ROW_HEIGHT = 36
const VIEW_HEIGHT = 300
const OVERSCAN = 6

const open = ref(false)
const search = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const failed = ref(false)

const selectedNode = computed(() => (selected.value ? iconLibrary.value?.ICON_LIBRARY[selected.value] : undefined))
watch(selected, (icon) => { if (icon) void loadIconLibrary().catch(() => undefined) }, { immediate: true })

watch(open, async (isOpen) => {
  if (!isOpen) return
  search.value = ''
  scrollTop.value = 0
  failed.value = false
  loadIconLibrary().catch(() => (failed.value = true))
  await nextTick()
  // On a touch-only iPad, focusing would pop the on-screen keyboard over the grid.
  if (hasKeyboard.value) searchInput.value?.focus()
})

const filteredGroups = computed<IconGroup[]>(() => {
  const groups = iconLibrary.value?.ICON_GROUPS ?? []
  const query = search.value.trim().toLowerCase()
  if (!query) return groups
  return groups
    .map((g) => ({ title: g.title, items: g.title.toLowerCase().includes(query) ? g.items : g.items.filter((icon) => icon.includes(query)) }))
    .filter((g) => g.items.length)
})

const rows = computed<Row[]>(() => filteredGroups.value.flatMap((g, gi) => [
  { type: 'label' as const, id: `label-${gi}`, title: g.title },
  ...Array.from({ length: Math.ceil(g.items.length / COLUMNS) }, (_, ri) => ({
    type: 'icons' as const, id: `icons-${gi}-${ri}`, icons: g.items.slice(ri * COLUMNS, ri * COLUMNS + COLUMNS),
  })),
]))

/** Only the rows in (or near) view are rendered; the full list is 200+ rows. */
const first = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN))
const visibleRows = computed(() => rows.value.slice(first.value, first.value + Math.ceil(VIEW_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2))

watch(search, () => {
  scrollTop.value = 0
  if (scroller.value) scroller.value.scrollTop = 0
})

function select(icon: string | null) {
  selected.value = icon
  open.value = false
}
/** Enter picks the first match, so search + Enter works without the mouse. */
function selectFirstMatch() {
  const icon = filteredGroups.value[0]?.items[0]
  if (icon) select(icon)
}
</script>

<template>
  <Popover v-model:open="open" :disabled="disabled">
    <template #trigger>
      <button type="button" class="trigger" :disabled="disabled" :aria-label="selected ? `Icon: ${selected}` : 'Choose icon'"
              :aria-expanded="open" aria-haspopup="dialog" data-testid="icon-grid-trigger">
        <SvgIcon v-if="selectedNode" :node="selectedNode" :size="18" :style="{ color: props.color || undefined }" />
        <span v-else class="empty" />
      </button>
    </template>
    <div class="picker" role="dialog" aria-label="Icons">
      <div class="top">
        <input ref="searchInput" v-model="search" class="input" type="search" placeholder="Search icons" aria-label="Search icons"
               autocomplete="off" spellcheck="false" data-testid="icon-search" @keydown.enter.prevent="selectFirstMatch" />
        <button v-if="selected" type="button" class="btn small ghost" data-testid="icon-none" @click="select(null)">No icon</button>
      </div>
      <p v-if="failed" class="msg">Could not load the icons.</p>
      <p v-else-if="!iconLibrary" class="msg">Loading icons…</p>
      <p v-else-if="!rows.length" class="msg">No icons found.</p>
      <div v-else ref="scroller" class="scroll" :style="{ maxHeight: `${VIEW_HEIGHT}px` }" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop">
        <div :style="{ height: `${rows.length * ROW_HEIGHT}px` }">
          <div :style="{ transform: `translateY(${first * ROW_HEIGHT}px)` }">
            <template v-for="row in visibleRows" :key="row.id">
              <div v-if="row.type === 'label'" class="label">{{ row.title }}</div>
              <div v-else class="icons" :style="{ color: props.color || undefined }">
                <button v-for="icon in row.icons" :key="icon" type="button" class="icon" :class="{ on: icon === selected }"
                        :aria-label="icon" :aria-pressed="icon === selected" :title="icon" @click="select(icon)">
                  <SvgIcon :node="iconLibrary.ICON_LIBRARY[icon]" :size="18" />
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Popover>
</template>

<style scoped>
.trigger {
  width: var(--target); height: var(--target); flex: none; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--gray-175); border-radius: var(--radius); background: var(--surface); color: var(--text);
}
.trigger:hover:not(:disabled) { background: var(--surface-2); }
.trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.empty { width: 16px; height: 16px; border-radius: 4px; background: var(--surface-3); }
.picker { width: 312px; display: flex; flex-direction: column; }
.top { display: flex; gap: 6px; padding: 8px; }
.top .input { min-height: 36px; flex: 1; min-width: 0; }
.msg { margin: 0; padding: 4px 12px 12px; font-size: 13px; color: var(--muted); }
.scroll { overflow-y: auto; padding: 0 8px 8px; overscroll-behavior: contain; }
.label { height: 36px; display: flex; align-items: flex-end; padding-bottom: 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
.icons { height: 36px; display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; }
.icon {
  height: 34px; display: inline-flex; align-items: center; justify-content: center; padding: 0;
  border: 1px solid transparent; border-radius: var(--radius); background: transparent; color: inherit;
}
.icon:hover { background: var(--surface-2); }
.icon.on { border-color: var(--accent); background: var(--accent-soft); }
</style>
