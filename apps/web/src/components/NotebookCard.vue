<script setup lang="ts">
import type { NotebookEntry } from '@folio/document'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { timeAgo } from '../composables'
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
  <article class="card" draggable="true" @dragstart="dragStart" data-testid="notebook-card" :data-title="entry.title">
    <button class="thumb" @click="$emit('open')" :aria-label="`Open ${entry.title}`">
      <img v-if="thumb" :src="thumb" alt="" loading="lazy" draggable="false" />
      <Icon v-else name="notebook" :size="32" />
    </button>
    <div class="meta">
      <Icon name="notebook" :size="16" class="kind" />
      <div class="text">
        <button class="title" @click="$emit('open')">{{ entry.title || 'Untitled' }}</button>
        <div class="sub">
          <span>Edited {{ timeAgo(entry.updatedAt) }}</span>
          <button v-for="t in entry.tags" :key="t" class="tag" @click="$emit('tag', t)">#{{ t }}</button>
        </div>
      </div>
      <Menu :items="items" align="right">
        <button class="icon-btn mini" :aria-label="`Actions for ${entry.title}`" data-testid="card-menu"><Icon name="more" :size="18" /></button>
      </Menu>
    </div>
  </article>
</template>

<style scoped>
.card {
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
  transition: border-color 0.12s, box-shadow 0.12s;
}
.card:hover { border-color: var(--border-strong); box-shadow: var(--shadow); }
.thumb {
  aspect-ratio: 16 / 10; border: 0; padding: 0; overflow: hidden; display: flex; align-items: center; justify-content: center;
  background: var(--surface-2); color: var(--muted); border-bottom: 1px solid var(--border);
}
.thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top left; background: #fff; }
.meta { display: flex; align-items: flex-start; gap: 10px; padding: 10px 6px 12px 12px; }
.kind { flex: none; margin-top: 2px; color: var(--accent); }
.text { flex: 1; min-width: 0; }
.title {
  display: block; width: 100%; padding: 0; border: 0; background: transparent; text-align: left;
  font-size: 13.5px; font-weight: 600; color: var(--text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sub { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin-top: 2px; font-size: 12.5px; color: var(--muted); }
.tag { padding: 0; border: 0; background: transparent; color: var(--muted); font-size: inherit; }
.tag:hover { color: var(--accent); }
.mini { width: 30px; height: 30px; margin-top: -4px; color: var(--muted); }
@media (hover: hover) {
  .mini { opacity: 0; }
  .card:hover .mini, .card:focus-within .mini { opacity: 1; }
}
</style>
