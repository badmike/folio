<script setup lang="ts">
import { ICONS, type IconName } from '../icons'
import SvgIcon from './SvgIcon.vue'

withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 22 })
</script>

<template>
  <SvgIcon :node="ICONS[name]" :size="size" />
</template>
