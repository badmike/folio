<script setup lang="ts">
import type { BackgroundPattern } from '@folio/document'
import { computed } from 'vue'
import { patternMask } from '../patterns'

/** Preview of a page pattern in the current text colour. */
const props = defineProps<{ pattern: BackgroundPattern }>()
const style = computed(() => {
  const mask = patternMask(props.pattern)
  return { maskImage: mask, WebkitMaskImage: mask }
})
</script>

<template>
  <span class="pattern-glyph" :style="style" aria-hidden="true" />
</template>

<style scoped>
.pattern-glyph {
  display: block; background-color: currentColor; opacity: 0.55;
  mask-size: cover; -webkit-mask-size: cover; mask-position: center; -webkit-mask-position: center;
}
</style>
