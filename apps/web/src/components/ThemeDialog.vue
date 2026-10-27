<script setup lang="ts">
import type { ThemeId } from '@folio/document'
import { ref } from 'vue'
import Modal from './Modal.vue'
import Switch from './Switch.vue'
import ThemePicker from './ThemePicker.vue'

/** Pick a notebook's theme; optionally repaint the paper of its existing pages. */
const props = defineProps<{ current: ThemeId }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'apply', o: { theme: ThemeId; repaint: boolean }): void
}>()

const theme = ref<ThemeId>(props.current)
const repaint = ref(true)
</script>

<template>
  <Modal title="Notebook theme" description="How shapes, text and colours look in this notebook. Your handwriting keeps its shape." @close="emit('close')">
    <ThemePicker v-model="theme" label="Theme" />
    <div class="repaint">
      <div class="text">
        <div class="name">Repaint existing pages</div>
        <p>Give every page the theme's paper. Patterns stay, dark pages stay dark.</p>
      </div>
      <Switch v-model="repaint" label="Repaint existing pages" data-testid="theme-repaint" />
    </div>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="button" data-testid="theme-apply" @click="emit('apply', { theme, repaint })">Apply</button>
    </template>
  </Modal>
</template>

<style scoped>
.repaint { display: flex; align-items: center; gap: 16px; margin-top: 14px; }
.text { flex: 1; min-width: 0; }
.name { font-size: 14px; font-weight: 600; color: var(--text-strong); }
.text p { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
</style>
