<script setup lang="ts">
import type { SearchHit } from '@folio/persistence'
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderSnippet } from '../composables'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import Icon from './Icon.vue'
import Sheet from './Sheet.vue'

defineEmits<{ (e: 'close'): void }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const q = ref('')
const hits = ref<SearchHit[]>([])
const input = ref<HTMLInputElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

onMounted(() => input.value?.focus())
onBeforeUnmount(() => { clearTimeout(timer); ctl.clearHighlight() })

watch(q, (v) => {
  clearTimeout(timer)
  if (!v.trim()) { hits.value = []; ctl.clearHighlight(); return }
  timer = setTimeout(async () => {
    const my = ++seq
    // make sure recent edits are searchable
    await ctl.ws.reindexNow(ctl.id)
    const r = (await ctl.ws.search(v, 100)).filter((h) => h.notebookId === ctl.id)
    if (my === seq) hits.value = r
  }, 150)
})

const pageName = (id: string | null) => {
  if (!id) return 'Notebook'
  const i = ctl.pages.value.findIndex((p) => p.id === id)
  return i < 0 ? 'Page' : ctl.pages.value[i].title || `Page ${i + 1}`
}
function go(h: SearchHit) {
  ctl.focus(h.pageId, h.objectId, h.bounds)
}
</script>

<template>
  <Sheet title="Search in notebook" @close="$emit('close')">
    <div class="box">
      <Icon name="search" :size="18" />
      <input ref="input" v-model="q" type="search" placeholder="Find text, handwriting, labels" aria-label="Search in this notebook" data-testid="nb-search-input" />
    </div>
    <p v-if="q.trim() && !hits.length" class="muted">No matches.</p>
    <ul data-testid="nb-search-results">
      <li v-for="(h, i) in hits" :key="i">
        <button class="hit" data-testid="nb-search-hit" @click="go(h)">
          <span class="where">{{ pageName(h.pageId) }} · {{ h.kind }}</span>
          <span class="snip" v-html="renderSnippet(h.snippet)" />
        </button>
      </li>
    </ul>
  </Sheet>
</template>

<style scoped>
.box { display: flex; align-items: center; gap: 8px; padding: 0 12px; min-height: 44px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); margin-bottom: 12px; }
.box:focus-within { border-color: var(--accent); }
input { flex: 1; min-width: 0; background: transparent; border: 0; outline: none; min-height: 40px; }
ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.hit { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1px solid var(--border); background: var(--surface); border-radius: 10px; }
.hit:hover { border-color: var(--accent); }
.where { font-size: 12px; color: var(--muted); }
.snip { overflow-wrap: anywhere; }
</style>
