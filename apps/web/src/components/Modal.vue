<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import Icon from './Icon.vue'

/**
 * `description`: a muted line under the title. `bare`: a large panel without header or padding; the
 * slot draws its own chrome and close button.
 */
defineProps<{ title: string; description?: string; wide?: boolean; bare?: boolean }>()
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
          <p v-if="description" class="description">{{ description }}</p>
          <button class="icon-btn close" aria-label="Close" @click="emit('close')"><Icon name="x" :size="16" /></button>
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
  position: fixed; inset: 0; z-index: 900; background: rgba(10, 10, 20, 0.5); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
  padding: max(16px, var(--safe-top)) max(16px, var(--safe-right)) max(16px, var(--safe-bottom)) max(16px, var(--safe-left));
}
.modal { width: min(460px, 100%); max-height: 100%; display: flex; flex-direction: column; overflow: hidden; border-radius: 14px; }
.modal.wide { width: min(640px, 100%); }
.modal.bare { width: min(880px, 100%); height: min(640px, 100%); }
header { position: relative; padding: 22px 52px 4px 24px; }
h2 { font-size: 20px; font-weight: 650; color: var(--text-strong); letter-spacing: -0.01em; }
.description { margin: 6px 0 0; font-size: 14px; line-height: 1.45; color: var(--muted); }
.close { position: absolute; top: 14px; right: 14px; width: 30px; height: 30px; color: var(--muted); }
.close:hover { color: var(--text-strong); }
.body { padding: 16px 24px 8px; overflow: auto; }
footer { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 24px 22px; }
footer :deep(.btn) { min-height: 36px; padding: 0 14px; font-size: 14px; font-weight: 550; }
.modal :deep(.field > label), .modal :deep(.field > .label) { font-size: 14px; font-weight: 600; color: var(--text-strong); }
.modal :deep(.field) { margin-bottom: 18px; }
.modal :deep(.field:last-child) { margin-bottom: 0; }
.modal :deep(.input) { min-height: 40px; }
@media (pointer: coarse) { footer :deep(.btn) { min-height: 40px; } }
</style>
