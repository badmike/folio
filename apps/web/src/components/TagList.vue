<script setup lang="ts">
import type { Tag } from '../services/workspace'
import Icon from './Icon.vue'
import IconName from './IconName.vue'
import Menu, { type MenuItem } from './Menu.vue'

/** Sidebar list of tags with their icon and colour; a tap filters by the tag. */
defineProps<{ tags: Tag[]; selected: string | null; counts: Record<string, number> }>()
const emit = defineEmits<{ (e: 'select', name: string): void; (e: 'edit', name: string): void }>()

const menuFor = (t: Tag): MenuItem[] => [{ label: 'Edit…', icon: 'edit', action: () => emit('edit', t.name) }]
</script>

<template>
  <nav class="tags" aria-label="Tags">
    <div class="row section"><span class="label">Tags</span></div>
    <div v-for="t in tags" :key="t.name" class="row item" :class="{ on: selected === t.name }" data-testid="tag-row" @click="emit('select', t.name)">
      <IconName class="label-name" :icon="t.icon" :color="t.color" :name="t.name" fallback="tag" :size="18" />
      <span class="count">{{ counts[t.name] ?? 0 }}</span>
      <Menu :items="menuFor(t)" align="right">
        <button class="icon-btn mini act" :aria-label="`Tag actions for ${t.name}`"><Icon name="more" :size="16" /></button>
      </Menu>
    </div>
  </nav>
</template>

<style scoped>
.tags { display: flex; flex-direction: column; gap: 1px; }
.item { min-height: 34px; padding: 0 4px 0 10px; border-radius: var(--radius); cursor: pointer; user-select: none; font-size: 14px; }
.item:hover { background: var(--surface-2); }
.item.on { background: var(--surface-3); color: var(--text-strong); font-weight: 600; }
.item :deep(svg) { flex: none; color: var(--muted); }
.item.on :deep(svg) { color: var(--text-strong); }
.section { margin: 14px 0 2px; padding: 0 4px 0 10px; min-height: 26px; }
.label { flex: 1; font-size: 12px; font-weight: 600; color: var(--muted); }
.label-name { flex: 1; }
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
