<script setup lang="ts">
import type { SearchHit } from '@folio/persistence'
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import Icon from './Icon.vue'
import SearchResults from './SearchResults.vue'
import Sheet from './Sheet.vue'

defineEmits<{ (e: 'close'): void }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const q = ref('')
const hits = ref<SearchHit[]>([])
const searching = ref(false)
const input = ref<HTMLInputElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

onMounted(() => input.value?.focus())
onBeforeUnmount(() => { clearTimeout(timer); ctl.clearHighlight() })

watch(q, (v) => {
  clearTimeout(timer)
  if (!v.trim()) { hits.value = []; searching.value = false; ctl.clearHighlight(); return }
  searching.value = true
  timer = setTimeout(async () => {
    const my = ++seq
    // make sure recent edits are searchable
    await ctl.ws.reindexNow(ctl.id)
    const r = (await ctl.ws.search(v, 100)).filter((h) => h.notebookId === ctl.id)
    if (my === seq) { hits.value = r; searching.value = false }
  }, 150)
})

const pageName = (id: string) => {
  if (!id) return 'Notebook'
  const i = ctl.pages.value.findIndex((p) => p.id === id)
  return i < 0 ? 'Page' : ctl.pages.value[i].title || `Page ${i + 1}`
}
function go(h: SearchHit) {
  ctl.focus(h.pageId, h.objectId, h.bounds)
}
</script>

<template>
  <Sheet title="Search" @close="$emit('close')">
    <label class="box">
      <Icon name="search" :size="16" />
      <input ref="input" v-model="q" type="search" placeholder="Search this notebook" aria-label="Search in this notebook" data-testid="nb-search-input" />
      <button v-if="q" class="icon-btn clear" aria-label="Clear search" @click="q = ''"><Icon name="x" :size="14" /></button>
    </label>
    <p v-if="!q.trim()" class="note">Finds typed text, handwriting and shape labels on every page.</p>
    <p v-else-if="!searching && !hits.length" class="note">No matches for “{{ q }}”.</p>
    <SearchResults v-else data-testid="nb-search-results" :hits="hits" :group-of="(h) => h.pageId ?? ''" :title-of="pageName"
      testid="nb-search-hit" @pick="go" />
  </Sheet>
</template>

<style scoped>
.box {
  display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 4px 0 10px; margin-bottom: 14px; cursor: text;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); color: var(--muted);
}
.box:focus-within { border-color: var(--accent); }
input { flex: 1; min-width: 0; min-height: 34px; border: 0; background: transparent; outline: none; font-size: 14px; color: var(--text-strong); }
input::-webkit-search-cancel-button { display: none; }
.clear { width: 28px; height: 28px; }
.note { margin: 4px 10px; font-size: 13px; color: var(--muted); }
</style>
