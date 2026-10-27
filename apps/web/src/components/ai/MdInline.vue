<script setup lang="ts">
import type { Inline } from '../../ai/markdown'

defineProps<{ nodes: Inline[] }>()
</script>

<template>
  <template v-for="(n, i) in nodes" :key="i">
    <template v-if="n.t === 'text'">{{ n.v }}</template>
    <code v-else-if="n.t === 'code'">{{ n.v }}</code>
    <strong v-else-if="n.t === 'strong'"><MdInline :nodes="n.c" /></strong>
    <em v-else-if="n.t === 'em'"><MdInline :nodes="n.c" /></em>
    <a v-else :href="n.href" target="_blank" rel="noopener noreferrer"><MdInline :nodes="n.c" /></a>
  </template>
</template>
