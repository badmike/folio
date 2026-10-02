<script setup lang="ts">
import type { PageFormat } from '@folio/document'
import { computed, inject } from 'vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import { confirmDialog, promptDialog } from '../services/dialogs'
import Icon from './Icon.vue'
import BackgroundSection from './BackgroundSection.vue'
import Menu, { type MenuItem } from './Menu.vue'
import Sheet from './Sheet.vue'

defineEmits<{ (e: 'close'): void }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const pages = ctl.pages
const cur = computed(() => pages.value.find((p) => p.id === ctl.pageId.value))
const label = (i: number) => pages.value[i].title || `Page ${i + 1}`
const kindLabel = (i: number) => {
  const p = pages.value[i]
  return p.kind === 'infinite' ? 'Infinite' : (p.format ?? 'Fixed')
}
async function rename(i: number) {
  const p = pages.value[i]
  const t = await promptDialog({ title: 'Rename page', label: 'Page title', value: p.title })
  if (t !== null) ctl.updatePage(p.id, { title: t.trim() })
}
async function remove(i: number) {
  const p = pages.value[i]
  if (await confirmDialog({ title: 'Delete page?', message: `“${label(i)}” and everything on it will be deleted.`, confirmLabel: 'Delete', danger: true })) {
    ctl.deletePage(p.id)
  }
}
const addItems: MenuItem[] = (['infinite', 'A4', 'Letter', 'iPad'] as const).map((k) => ({
  label: k === 'infinite' ? 'Infinite page' : `${k} page`, icon: 'plus', action: () => ctl.addPage(k as 'infinite' | PageFormat),
}))
</script>

<template>
  <Sheet title="Pages" @close="$emit('close')">
    <ul class="pages" data-testid="page-list">
      <li v-for="(p, i) in pages" :key="p.id" :class="{ on: p.id === ctl.pageId.value }">
        <button class="name" data-testid="page-item" @click="ctl.setPage(p.id)">
          <strong>{{ label(i) }}</strong><span class="muted">{{ kindLabel(i) }}</span>
        </button>
        <button class="icon-btn mini" :disabled="i === 0" aria-label="Move up" @click="ctl.movePage(p.id, -1)"><Icon name="up" :size="18" /></button>
        <button class="icon-btn mini" :disabled="i === pages.length - 1" aria-label="Move down" @click="ctl.movePage(p.id, 1)"><Icon name="down" :size="18" /></button>
        <button class="icon-btn mini" aria-label="Rename page" @click="rename(i)"><Icon name="edit" :size="18" /></button>
        <button class="icon-btn mini danger" :disabled="pages.length <= 1" aria-label="Delete page" @click="remove(i)"><Icon name="trash" :size="18" /></button>
      </li>
    </ul>
    <Menu :items="addItems" up>
      <button class="btn add" data-testid="add-page"><Icon name="plus" :size="18" /> Add page</button>
    </Menu>

    <BackgroundSection v-if="cur" :page="cur" />
  </Sheet>
</template>

<style scoped>
.pages { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.pages li { display: flex; align-items: center; border-radius: 10px; padding-right: 2px; }
.pages li.on { background: var(--accent-soft); }
.name { flex: 1; min-width: 0; display: flex; flex-direction: column; text-align: left; border: 0; background: transparent; padding: 6px 10px; min-height: 44px; }
.name span { font-size: 12px; }
.name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mini { width: 36px; height: 36px; }
.add { width: 100%; }
</style>
