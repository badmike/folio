<script setup lang="ts">
import type { FolderEntry } from '@folio/document'
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import Menu, { type MenuItem } from './Menu.vue'

const props = defineProps<{ folders: FolderEntry[]; selected: string; counts: Record<string, number> }>()
const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'create', parentId: string | null): void
  (e: 'rename', id: string): void
  (e: 'move', id: string): void
  (e: 'delete', id: string): void
  (e: 'drop', folderId: string | null, notebookId: string): void
}>()

interface Row { folder: FolderEntry; depth: number }
const rows = computed<Row[]>(() => {
  const byParent = new Map<string | null, FolderEntry[]>()
  for (const f of props.folders) {
    const list = byParent.get(f.parentId) ?? []
    list.push(f)
    byParent.set(f.parentId, list)
  }
  const out: Row[] = []
  const walk = (parent: string | null, depth: number, seen: Set<string>) => {
    for (const f of byParent.get(parent) ?? []) {
      if (seen.has(f.id)) continue
      out.push({ folder: f, depth })
      walk(f.id, depth + 1, new Set(seen).add(f.id))
    }
  }
  walk(null, 0, new Set())
  return out
})

const dropTarget = ref<string | null | undefined>(undefined)
function onDrop(e: DragEvent, folderId: string | null) {
  dropTarget.value = undefined
  const id = e.dataTransfer?.getData('application/x-folio-notebook')
  if (id) emit('drop', folderId, id)
}
function menuFor(f: FolderEntry): MenuItem[] {
  return [
    { label: 'New subfolder', icon: 'plus', action: () => emit('create', f.id) },
    { label: 'Rename', icon: 'edit', action: () => emit('rename', f.id) },
    { label: 'Move…', icon: 'move', action: () => emit('move', f.id) },
    { divider: true },
    { label: 'Delete folder', icon: 'trash', danger: true, action: () => emit('delete', f.id) },
  ]
}
</script>

<template>
  <nav class="tree" aria-label="Folders">
    <div class="row item" :class="{ on: selected === 'all', drop: dropTarget === null }" @click="emit('select', 'all')"
         @dragover.prevent="dropTarget = null" @dragleave="dropTarget = undefined" @drop.prevent="onDrop($event, null)">
      <Icon name="library" :size="18" /><span class="name">All notebooks</span><span class="count">{{ counts.all ?? 0 }}</span>
    </div>
    <div class="row section">
      <span class="label">Folders</span>
      <button class="icon-btn mini" aria-label="New folder" title="New folder" data-testid="new-folder" @click="emit('create', null)"><Icon name="plus" :size="16" /></button>
    </div>
    <div v-for="r in rows" :key="r.folder.id" class="row item" :class="{ on: selected === r.folder.id, drop: dropTarget === r.folder.id }"
         :style="{ paddingLeft: 10 + r.depth * 16 + 'px' }" @click="emit('select', r.folder.id)"
         @dragover.prevent="dropTarget = r.folder.id" @dragleave="dropTarget = undefined" @drop.prevent="onDrop($event, r.folder.id)"
         data-testid="folder-row">
      <Icon name="folder" :size="18" /><span class="name">{{ r.folder.name }}</span>
      <span class="count">{{ counts[r.folder.id] ?? 0 }}</span>
      <Menu :items="menuFor(r.folder)" align="right">
        <button class="icon-btn mini act" :aria-label="`Folder actions for ${r.folder.name}`"><Icon name="more" :size="16" /></button>
      </Menu>
    </div>
  </nav>
</template>

<style scoped>
.tree { display: flex; flex-direction: column; gap: 1px; }
.item { min-height: 34px; padding: 0 4px 0 10px; border-radius: var(--radius); cursor: pointer; user-select: none; font-size: 14px; }
.item:hover { background: var(--surface-2); }
.item.on { background: var(--surface-3); color: var(--text-strong); font-weight: 600; }
.item.drop { outline: 2px dashed var(--accent); outline-offset: -2px; }
.item :deep(svg) { flex: none; color: var(--muted); }
.item.on :deep(svg) { color: var(--text-strong); }
.section { margin: 14px 0 2px; padding: 0 4px 0 10px; }
.label { flex: 1; font-size: 12px; font-weight: 600; color: var(--muted); }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-size: 12px; color: var(--muted); min-width: 16px; padding-right: 6px; text-align: right; font-variant-numeric: tabular-nums; }
.mini { width: 26px; height: 26px; color: var(--muted); }
@media (hover: hover) {
  .act { display: none; }
  .item:hover .act, .item:focus-within .act { display: inline-flex; }
  .item:hover .count:not(:last-child), .item:focus-within .count:not(:last-child) { display: none; }
}
@media (pointer: coarse) {
  .item { min-height: 44px; }
  .mini { width: 36px; height: 36px; }
}
</style>
