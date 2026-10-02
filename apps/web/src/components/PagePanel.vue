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
function menuFor(i: number): MenuItem[] {
  const p = pages.value[i]
  return [
    { label: 'Rename', icon: 'edit', action: () => void rename(i) },
    { label: 'Move up', icon: 'up', disabled: i === 0, action: () => ctl.movePage(p.id, -1) },
    { label: 'Move down', icon: 'down', disabled: i === pages.value.length - 1, action: () => ctl.movePage(p.id, 1) },
    { divider: true },
    { label: 'Delete page', icon: 'trash', danger: true, disabled: pages.value.length <= 1, action: () => void remove(i) },
  ]
}
const addItems: MenuItem[] = (['infinite', 'A4', 'Letter', 'iPad'] as const).map((k) => ({
  label: k === 'infinite' ? 'Infinite page' : `${k} page`, icon: 'plus', action: () => ctl.addPage(k as 'infinite' | PageFormat),
}))
</script>

<template>
  <Sheet title="Pages" @close="$emit('close')">
    <div class="section">
      <span class="label">{{ pages.length }} {{ pages.length === 1 ? 'page' : 'pages' }}</span>
      <Menu :items="addItems" align="right">
        <button class="icon-btn mini" aria-label="Add page" title="Add page" data-testid="add-page"><Icon name="plus" :size="16" /></button>
      </Menu>
    </div>
    <ul class="pages" data-testid="page-list">
      <li v-for="(p, i) in pages" :key="p.id" :class="{ on: p.id === ctl.pageId.value }">
        <button class="name" data-testid="page-item" @click="ctl.setPage(p.id)">
          <Icon :name="p.kind === 'infinite' ? 'grid' : 'doc'" :size="16" />
          <span class="title">{{ label(i) }}</span>
          <span class="kind">{{ kindLabel(i) }}</span>
        </button>
        <Menu :items="menuFor(i)" align="right">
          <button class="icon-btn mini act" :aria-label="`Actions for ${label(i)}`"><Icon name="more" :size="16" /></button>
        </Menu>
      </li>
    </ul>

    <BackgroundSection v-if="cur" :page="cur" />
  </Sheet>
</template>

<style scoped>
.section { display: flex; align-items: center; padding: 0 0 4px 10px; }
.label { flex: 1; font-size: 12px; font-weight: 600; color: var(--muted); }
.pages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.pages li { display: flex; align-items: center; border-radius: var(--radius); padding-right: 4px; }
.pages li:hover { background: var(--surface-2); }
.pages li.on { background: var(--surface-3); }
.name {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 0 6px 0 10px;
  border: 0; background: transparent; text-align: left; font-size: 14px;
}
.name :deep(svg) { flex: none; color: var(--muted); }
.on .name { color: var(--text-strong); font-weight: 600; }
.on .name :deep(svg) { color: var(--accent); }
.title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kind { font-size: 12px; font-weight: 400; color: var(--muted); }
.mini { width: 26px; height: 26px; color: var(--muted); }
@media (hover: hover) {
  .act { visibility: hidden; }
  li:hover .act, li:focus-within .act { visibility: visible; }
}
@media (pointer: coarse) {
  .name { min-height: 44px; }
  .mini { width: 36px; height: 36px; }
}
</style>
