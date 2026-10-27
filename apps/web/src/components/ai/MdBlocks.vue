<script setup lang="ts">
import type { Block } from '../../ai/markdown'
import MdInline from './MdInline.vue'

defineProps<{ blocks: Block[] }>()
</script>

<template>
  <template v-for="(b, i) in blocks" :key="i">
    <h3 v-if="b.t === 'heading' && b.level === 1"><MdInline :nodes="b.c" /></h3>
    <h4 v-else-if="b.t === 'heading' && b.level === 2"><MdInline :nodes="b.c" /></h4>
    <h5 v-else-if="b.t === 'heading'"><MdInline :nodes="b.c" /></h5>
    <p v-else-if="b.t === 'paragraph'"><MdInline :nodes="b.c" /></p>
    <ol v-else-if="b.t === 'list' && b.ordered" :start="b.start">
      <li v-for="(item, j) in b.items" :key="j"><MdBlocks :blocks="item" /></li>
    </ol>
    <ul v-else-if="b.t === 'list'">
      <li v-for="(item, j) in b.items" :key="j"><MdBlocks :blocks="item" /></li>
    </ul>
    <pre v-else-if="b.t === 'code'"><code>{{ b.v }}</code></pre>
    <blockquote v-else-if="b.t === 'quote'"><MdBlocks :blocks="b.c" /></blockquote>
    <hr v-else />
  </template>
</template>
