<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { IconName } from '../icons'
import { rankPalette, type PaletteGroup, type PaletteItem, type PaletteRow } from '../services/palette'
import Icon from './Icon.vue'

/**
 * Cmd+K palette. Keyboard first: arrows move, Enter runs, Esc closes. With a query, the last row asks
 * the AI (`ask`), which is what Enter does when nothing else matches.
 */
const props = withDefaults(defineProps<{ items: PaletteItem[]; placeholder?: string; canAsk?: boolean }>(), {
  placeholder: 'Jump to a page or notebook, run a command, or ask AI',
  canAsk: true,
})
const emit = defineEmits<{ (e: 'close'): void; (e: 'ask', query: string): void }>()

const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
const rows = computed(() => rankPalette(props.items, query.value, props.canAsk))
watch(rows, () => { active.value = 0 })

function run(row: PaletteRow) {
  emit('close')
  if (row.kind === 'ask') emit('ask', row.query)
  else row.item.run()
}

function move(by: number) {
  const n = rows.value.length
  if (!n) return
  active.value = (active.value + by + n) % n
  void nextTick(() => list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    move(e.key === 'ArrowDown' ? 1 : -1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const row = rows.value[active.value]
    if (row) run(row)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

const GROUP_LABEL: Record<PaletteGroup, string> = { page: 'Page', notebook: 'Notebook', command: 'Command' }
const GROUP_ICON: Record<PaletteGroup, IconName> = { page: 'doc', notebook: 'notebook', command: 'menu' }
onMounted(() => input.value?.focus())
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" data-testid="palette" @pointerdown.self="emit('close')">
      <div class="palette panel floating" role="dialog" aria-modal="true" aria-label="Command palette">
        <label class="query">
          <Icon name="search" :size="17" />
          <input ref="input" v-model="query" type="text" :placeholder="placeholder" role="combobox" aria-expanded="true" aria-controls="palette-list"
                 aria-autocomplete="list" autocomplete="off" spellcheck="false" data-testid="palette-input" @keydown="onKeydown" />
        </label>
        <ul v-if="rows.length" id="palette-list" ref="list" class="rows" role="listbox" aria-label="Results">
          <li v-for="(row, i) in rows" :key="row.kind === 'ask' ? 'ask' : row.item.id" role="option" :aria-selected="i === active">
            <button class="row" :class="{ on: i === active, ask: row.kind === 'ask' }" tabindex="-1" :data-testid="row.kind === 'ask' ? 'palette-ask' : 'palette-row'"
                    @pointerenter="active = i" @click="run(row)">
              <template v-if="row.kind === 'ask'">
                <Icon name="sparkles" :size="16" />
                <span class="label">Ask AI: <strong>{{ row.query }}</strong></span>
              </template>
              <template v-else>
                <Icon :name="row.item.icon ?? GROUP_ICON[row.item.group]" :size="16" />
                <span class="label">{{ row.item.label }}</span>
                <span class="hint">{{ row.item.hint ?? GROUP_LABEL[row.item.group] }}</span>
              </template>
            </button>
          </li>
        </ul>
        <p v-else class="empty">Nothing matches.</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed; inset: 0; z-index: 900; background: rgba(10, 10, 20, 0.35);
  display: flex; justify-content: center; align-items: flex-start;
  padding: calc(12vh + var(--safe-top)) max(12px, var(--safe-right)) 16px max(12px, var(--safe-left));
}
.palette { width: min(580px, 100%); max-height: min(480px, 70vh); display: flex; flex-direction: column; overflow: hidden; border-radius: var(--radius-lg); }
.query { display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--border); color: var(--muted); }
.query input { flex: 1; min-width: 0; min-height: 50px; border: 0; outline: none; background: transparent; font-size: 15.5px; color: var(--text-strong); }
.query input::placeholder { color: var(--muted); }
.rows { list-style: none; margin: 0; padding: 6px; overflow-y: auto; overscroll-behavior: contain; }
.row {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 38px; padding: 0 10px; border: 0; border-radius: var(--radius);
  background: none; color: var(--text); text-align: left; font-size: 14px;
}
.row :deep(svg) { flex: none; color: var(--muted); }
.row.on { background: var(--surface-2); color: var(--text-strong); }
.row.ask :deep(svg) { color: var(--ai); }
.label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.label strong { font-weight: 600; color: var(--text-strong); }
.hint { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--muted); }
.empty { margin: 0; padding: 18px; font-size: 13.5px; color: var(--muted); text-align: center; }
@media (pointer: coarse) { .row { min-height: 44px; } }
</style>
