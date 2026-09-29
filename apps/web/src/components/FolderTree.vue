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
    <div class="row item" :class="{ on: selected === 'all' }" @click="emit('select', 'all')"
         @dragover.prevent="dropTarget = null" @dragleave="dropTarget = undefined" @drop.prevent="onDrop($event, null)"
         :data-drop="dropTarget === null">
      <Icon name="notebook" :size="18" /><span class="name">All notebooks</span><span class="count">{{ counts.all ?? 0 }}</span>
    </div>
    <div v-for="r in rows" :key="r.folder.id" class="row item" :class="{ on: selected === r.folder.id, drop: dropTarget === r.folder.id }"
         :style="{ paddingLeft: 10 + r.depth * 16 + 'px' }" @click="emit('select', r.folder.id)"
         @dragover.prevent="dropTarget = r.folder.id" @dragleave="dropTarget = undefined" @drop.prevent="onDrop($event, r.folder.id)"
         data-testid="folder-row">
      <Icon name="folder" :size="18" /><span class="name">{{ r.folder.name }}</span>
      <span class="count">{{ counts[r.folder.id] ?? 0 }}</span>
      <Menu :items="menuFor(r.folder)" align="right">
        <button class="icon-btn mini" :aria-label="`Folder actions for ${r.folder.name}`"><Icon name="more" :size="18" /></button>
      </Menu>
    </div>
    <button class="btn ghost small newf" data-testid="new-folder" @click="emit('create', null)"><Icon name="plus" :size="16" /> New folder</button>
  </nav>
</template>

<style scoped>
.tree { display: flex; flex-direction: column; gap: 2px; }
.item { min-height: 42px; padding: 0 4px 0 10px; border-radius: 10px; cursor: pointer; user-select: none; }
.item:hover { background: var(--surface-2); }
.item.on { background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }
.item.drop { outline: 2px dashed var(--accent); }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-size: 12px; color: var(--muted); min-width: 16px; text-align: right; }
.mini { width: 34px; height: 34px; }
.newf { align-self: flex-start; margin-top: 6px; color: var(--muted); }
</style>
