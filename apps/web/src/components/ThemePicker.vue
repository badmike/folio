<script setup lang="ts">
import { THEME_IDS, THEME_PRESETS, type ThemeId } from '@folio/document'
import { prefersDarkCanvas, themeFor } from '../services/themes'
import { computed } from 'vue'
import ThemePreview from './ThemePreview.vue'

/** Theme choice as a grid of previews (shown in the app's light or dark scheme). */
const model = defineModel<ThemeId>({ required: true })
defineProps<{ label: string }>()

const dark = prefersDarkCanvas()
const themes = computed(() =>
  THEME_IDS.map((id) => ({ id, label: THEME_PRESETS[id].label, description: THEME_PRESETS[id].description, theme: themeFor(id) })),
)
</script>

<template>
  <div class="themes" role="radiogroup" :aria-label="label">
    <button
      v-for="t in themes" :key="t.id" type="button" class="theme" :class="{ on: model === t.id }" role="radio"
      :aria-checked="model === t.id" :title="t.description" :data-testid="`theme-${t.id}`" @click="model = t.id"
    >
      <ThemePreview :theme="t.theme" :dark="dark" />
      <span class="name">{{ t.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.themes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.theme {
  display: flex; flex-direction: column; align-items: stretch; gap: 5px; padding: 6px 6px 7px;
  border: 1px solid transparent; border-radius: var(--radius); background: var(--surface-2); color: var(--text);
}
.theme:hover { background: var(--surface-3); }
.theme.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-strong); }
.theme:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.theme :deep(.theme-preview) { box-shadow: 0 0 0 1px var(--border); }
.name { font-size: 13px; font-weight: 600; text-align: center; }
</style>
