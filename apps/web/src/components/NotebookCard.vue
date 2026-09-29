<script setup lang="ts">
import type { NotebookEntry } from '@folio/document'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { formatDate } from '../composables'
import type { Workspace } from '../services/workspace'
import Icon from './Icon.vue'
import Menu, { type MenuItem } from './Menu.vue'

const props = defineProps<{ entry: NotebookEntry; ws: Workspace; items: MenuItem[] }>()
defineEmits<{ (e: 'open'): void; (e: 'tag', tag: string): void }>()

const thumb = ref<string | null>(null)
async function load() {
  try { thumb.value = await props.ws.getThumbnail(props.entry.id) } catch { thumb.value = null }
}
onMounted(load)
watch(() => props.entry.updatedAt, load)
const off = props.ws.onThumbnail((id) => { if (id === props.entry.id) void load() })
onBeforeUnmount(off)

function dragStart(e: DragEvent) {
  e.dataTransfer?.setData('application/x-folio-notebook', props.entry.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
</script>

<template>
  <article class="card panel" draggable="true" @dragstart="dragStart" data-testid="notebook-card" :data-title="entry.title">
    <button class="thumb" @click="$emit('open')" :aria-label="`Open ${entry.title}`">
      <img v-if="thumb" :src="thumb" alt="" loading="lazy" draggable="false" />
      <Icon v-else name="notebook" :size="36" />
    </button>
    <div class="meta">
      <div class="row">
        <button class="title" @click="$emit('open')">{{ entry.title || 'Untitled' }}</button>
        <Menu :items="items" align="right">
          <button class="icon-btn mini" :aria-label="`Actions for ${entry.title}`" data-testid="card-menu"><Icon name="more" :size="18" /></button>
        </Menu>
      </div>
      <div class="sub muted">{{ formatDate(entry.updatedAt) }}</div>
      <div v-if="entry.tags.length" class="tags">
        <button v-for="t in entry.tags" :key="t" class="chip" @click="$emit('tag', t)">{{ t }}</button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.card { overflow: hidden; display: flex; flex-direction: column; box-shadow: none; }
.card:hover { box-shadow: var(--shadow); }
.thumb {
  aspect-ratio: 4 / 3; border: 0; background: var(--surface-2); color: var(--muted); display: flex; align-items: center; justify-content: center; padding: 0;
  border-bottom: 1px solid var(--border); overflow: hidden;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top left; background: #fff; }
.meta { padding: 8px 6px 10px 12px; }
.title { flex: 1; text-align: left; border: 0; background: transparent; font-weight: 600; padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 34px; }
.mini { width: 34px; height: 34px; }
.sub { font-size: 12.5px; margin-top: -4px; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
</style>
