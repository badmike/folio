<script setup lang="ts">
import { computed } from 'vue'
import { parseMarkdown } from '../../ai/markdown'
import MdBlocks from './MdBlocks.vue'

const props = defineProps<{ text: string }>()
const blocks = computed(() => parseMarkdown(props.text))
</script>

<template>
  <div class="md selectable"><MdBlocks :blocks="blocks" /></div>
</template>

<style scoped>
.md { font-size: 14px; line-height: 1.55; color: var(--text-strong); overflow-wrap: anywhere; }
.md > :deep(:first-child) { margin-top: 0; }
.md > :deep(:last-child) { margin-bottom: 0; }
.md :deep(p) { margin: 0 0 8px; }
.md :deep(h3), .md :deep(h4), .md :deep(h5) { margin: 14px 0 6px; font-weight: 650; color: var(--text-strong); line-height: 1.3; }
.md :deep(h3) { font-size: 16px; }
.md :deep(h4) { font-size: 15px; }
.md :deep(h5) { font-size: 14px; }
.md :deep(ul), .md :deep(ol) { margin: 0 0 8px; padding-left: 20px; }
.md :deep(li) { margin: 2px 0; }
.md :deep(li > p) { margin: 0; }
.md :deep(li > ul), .md :deep(li > ol) { margin: 2px 0 0; }
.md :deep(code) { font-size: 12.5px; padding: 1px 4px; border-radius: 4px; background: var(--surface-2); }
.md :deep(pre) { margin: 0 0 8px; padding: 8px 10px; border-radius: var(--radius); background: var(--surface-2); overflow-x: auto; }
.md :deep(pre code) { padding: 0; background: none; }
.md :deep(blockquote) { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid var(--border-strong); color: var(--text); }
.md :deep(hr) { border: 0; border-top: 1px solid var(--border); margin: 12px 0; }
</style>
