<script setup lang="ts">
import type { BackgroundPattern, PageFormat } from '@folio/document'
import { computed, inject } from 'vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import { confirmDialog, promptDialog } from '../services/dialogs'
import Icon from './Icon.vue'
import Menu from './Menu.vue'
import Sheet from './Sheet.vue'

defineEmits<{ (e: 'close'): void }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const pages = ctl.pages
const cur = computed(() => pages.value.find((p) => p.id === ctl.pageId.value))
const PATTERNS: { v: BackgroundPattern; label: string }[] = [
  { v: 'blank', label: 'Blank' }, { v: 'ruled', label: 'Ruled' }, { v: 'grid', label: 'Grid' }, { v: 'dot', label: 'Dots' },
]
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
const addItems = (['infinite', 'A4', 'Letter', 'iPad'] as const).map((k) => ({
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

    <div v-if="cur" class="bg">
      <h4>Background of this page</h4>
      <div class="seg">
        <button v-for="p in PATTERNS" :key="p.v" :class="{ on: cur.background.pattern === p.v }" :data-testid="`bg-${p.v}`" @click="ctl.setBackground({ pattern: p.v })">{{ p.label }}</button>
      </div>
      <label class="slider"><span>Spacing</span>
        <input type="range" min="12" max="96" step="2" :value="cur.background.spacing" @input="ctl.setBackground({ spacing: Number(($event.target as HTMLInputElement).value) })" />
        <b>{{ cur.background.spacing }}</b></label>
      <label class="slider"><span>Line opacity</span>
        <input type="range" min="0.1" max="1" step="0.05" :value="cur.background.opacity" @input="ctl.setBackground({ opacity: Number(($event.target as HTMLInputElement).value) })" />
        <b>{{ Math.round(cur.background.opacity * 100) }}%</b></label>
      <label class="slider"><span>Paper color</span>
        <input type="color" class="color" :value="cur.background.color" @input="ctl.setBackground({ color: ($event.target as HTMLInputElement).value })" />
        <span />
      </label>
    </div>
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
.bg { margin-top: 20px; display: flex; flex-direction: column; gap: 10px; }
h4 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.slider { display: grid; grid-template-columns: 84px 1fr 42px; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
.slider b { color: var(--text); text-align: right; font-size: 12.5px; }
.color { width: 44px; height: 34px; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: none; }
</style>
