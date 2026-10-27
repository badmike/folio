<script setup lang="ts">
import type { IconNode } from '../icons'

/** Draws a Lucide icon from its vendored SVG child nodes. */
withDefaults(defineProps<{ node: IconNode; size?: number }>(), { size: 22 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <component :is="tag" v-for="([tag, attrs], i) in node" :key="i" v-bind="attrs" />
  </svg>
</template>
