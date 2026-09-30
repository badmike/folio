<script setup lang="ts">
import Icon from './Icon.vue'
defineProps<{ title: string }>()
defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <aside class="sheet panel floating" :aria-label="title" @pointerdown.stop>
    <header>
      <h3>{{ title }}</h3>
      <button class="icon-btn" aria-label="Close panel" @click="$emit('close')"><Icon name="x" /></button>
    </header>
    <div class="content"><slot /></div>
  </aside>
</template>

<style scoped>
.sheet {
  position: absolute; z-index: 30; top: calc(60px + var(--safe-top)); right: calc(8px + var(--safe-right)); bottom: calc(8px + var(--safe-bottom));
  width: 340px; display: flex; flex-direction: column; overflow: hidden;
}
header { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 4px 16px; border-bottom: 1px solid var(--border); }
h3 { font-size: 16px; }
.content { flex: 1; overflow: auto; padding: 14px 16px; }
@media (max-width: 640px) {
  .sheet { left: 8px; right: 8px; top: auto; height: min(62%, 520px); }
}
</style>
