<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import Icon from './Icon.vue'

/** `bare`: a large panel without header or padding; the slot draws its own chrome and close button. */
defineProps<{ title: string; wide?: boolean; bare?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') emit('close') }
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @pointerdown.self="emit('close')">
      <div class="modal panel floating" :class="{ wide, bare }" role="dialog" aria-modal="true" :aria-label="title">
        <slot v-if="bare" />
        <template v-else>
        <header>
          <h2>{{ title }}</h2>
          <button class="icon-btn" aria-label="Close" @click="emit('close')"><Icon name="x" /></button>
        </header>
        <div class="body"><slot /></div>
        <footer v-if="$slots.footer"><slot name="footer" /></footer>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed; inset: 0; z-index: 900; background: rgba(10, 10, 20, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: max(16px, var(--safe-top)) max(16px, var(--safe-right)) max(16px, var(--safe-bottom)) max(16px, var(--safe-left));
}
.modal { width: min(440px, 100%); max-height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.modal.wide { width: min(640px, 100%); }
.modal.bare { width: min(880px, 100%); height: min(640px, 100%); }
header { display: flex; align-items: center; justify-content: space-between; padding: 8px 8px 8px 20px; border-bottom: 1px solid var(--border); }
h2 { font-size: 17px; }
.body { padding: 18px 20px; overflow: auto; }
footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border); }
</style>
