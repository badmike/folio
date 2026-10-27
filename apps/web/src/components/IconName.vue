<script setup lang="ts">
import { computed, watch } from 'vue'
import { iconLibrary, loadIconLibrary } from '../icon-loader'
import type { IconName } from '../icons'
import Icon from './Icon.vue'
import SvgIcon from './SvgIcon.vue'

/**
 * A folder or tag label: its icon (from the icon library) in its colour, then the name.
 * Without an icon, `fallback` (an app icon) is drawn in the colour instead.
 */
const props = withDefaults(defineProps<{
  icon?: string | null
  color?: string | null
  name?: string
  fallback?: IconName
  size?: number
}>(), { size: 16 })

watch(() => props.icon, (icon) => { if (icon) void loadIconLibrary().catch(() => undefined) }, { immediate: true })
const node = computed(() => (props.icon ? iconLibrary.value?.ICON_LIBRARY[props.icon] : undefined))
/** Keeps the name from jumping sideways while the library loads. */
const pending = computed(() => !!props.icon && !iconLibrary.value)
const tint = computed(() => (props.color ? { color: props.color } : undefined))
</script>

<template>
  <span class="icon-name">
    <SvgIcon v-if="node" :node="node" :size="size" :style="tint" />
    <span v-else-if="pending" class="slot" :style="{ width: `${size}px`, height: `${size}px` }" />
    <Icon v-else-if="fallback" :name="fallback" :size="size" :style="tint" />
    <span v-if="name" class="name">{{ name }}</span>
  </span>
</template>

<style scoped>
.icon-name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.icon-name > svg, .slot { flex: none; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
