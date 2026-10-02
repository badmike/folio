<script setup lang="ts">
import { ICONS, type IconName } from '../icons'

withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 22 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <component :is="tag" v-for="([tag, attrs], i) in ICONS[name]" :key="i" v-bind="attrs" />
  </svg>
</template>
