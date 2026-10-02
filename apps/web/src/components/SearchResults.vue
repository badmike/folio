<script setup lang="ts">
import type { SearchHit } from '@folio/persistence'
import { computed } from 'vue'
import { renderSnippet } from '../composables'
import type { IconName } from '../icons'
import Icon from './Icon.vue'

/** Search hits grouped under a heading (the notebook or page they were found on), in rank order. */
const props = defineProps<{ hits: SearchHit[]; groupOf: (h: SearchHit) => string; titleOf: (group: string) => string; testid: string }>()
defineEmits<{ (e: 'pick', hit: SearchHit): void }>()

const ICON: Record<SearchHit['kind'], IconName> = { handwriting: 'pen', text: 'text', label: 'shape', tag: 'tag', title: 'notebook' }

const groups = computed(() => {
  const map = new Map<string, SearchHit[]>()
  for (const h of props.hits) {
    const key = props.groupOf(h)
    const list = map.get(key)
    if (list) list.push(h)
    else map.set(key, [h])
  }
  return [...map]
})
</script>

<template>
  <div class="results">
    <section v-for="[group, list] in groups" :key="group" class="group">
      <h4><span>{{ titleOf(group) }}</span><span class="count">{{ list.length }}</span></h4>
      <button v-for="(h, i) in list" :key="i" class="hit" :data-testid="testid" @click="$emit('pick', h)">
        <Icon :name="ICON[h.kind]" :size="16" class="kind" />
        <span class="snippet" v-html="renderSnippet(h.snippet)" />
        <span class="tag">{{ h.kind }}</span>
      </button>
    </section>
  </div>
</template>

<style scoped>
.results { display: flex; flex-direction: column; gap: 14px; }
h4 {
  display: flex; align-items: center; gap: 8px; margin: 0 0 2px; padding: 0 10px;
  font-size: 12px; font-weight: 600; color: var(--muted);
}
h4 span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-weight: 500; font-variant-numeric: tabular-nums; }
.hit {
  width: 100%; display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border: 0; border-radius: var(--radius);
  background: transparent; text-align: left; font-size: 14px; color: var(--text-strong);
}
.hit:hover { background: var(--surface-2); }
.kind { flex: none; margin-top: 2px; color: var(--muted); }
.snippet { flex: 1; min-width: 0; line-height: 1.4; overflow-wrap: anywhere; }
.tag { flex: none; margin-top: 1px; font-size: 12px; color: var(--muted); }
@media (pointer: coarse) { .hit { padding: 11px 10px; } }
</style>
