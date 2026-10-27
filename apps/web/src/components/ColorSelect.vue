<script setup lang="ts">
import { computed, ref } from 'vue'
import Popover from './Popover.vue'

/** Colour picker for folders and tags: a swatch trigger and a grid of named colours, including none. */
defineProps<{ disabled?: boolean }>()
const selected = defineModel<string | null>()

const COLORS: { value: string | null; label: string }[] = [
  { value: null, label: 'None' },
  { value: '#3B82F6', label: 'Blue' }, { value: '#10B981', label: 'Green' }, { value: '#F59E0B', label: 'Amber' },
  { value: '#EF4444', label: 'Red' }, { value: '#8B5CF6', label: 'Purple' }, { value: '#EC4899', label: 'Pink' },
  { value: '#14B8A6', label: 'Teal' }, { value: '#F97316', label: 'Orange' }, { value: '#A855F7', label: 'Violet' },
  { value: '#0EA5E9', label: 'Sky Blue' }, { value: '#84CC16', label: 'Lime' }, { value: '#6B7280', label: 'Gray' },
  { value: '#64748B', label: 'Slate' }, { value: '#1F2937', label: 'Dark Gray' }, { value: '#94A3B8', label: 'Cool Gray' },
  { value: '#FACC15', label: 'Yellow' }, { value: '#FB7185', label: 'Rose' }, { value: '#06B6D4', label: 'Cyan' },
  { value: '#4ADE80', label: 'Emerald' }, { value: '#C084FC', label: 'Lavender' }, { value: '#F43F5E', label: 'Crimson' },
  { value: '#22D3EE', label: 'Light Blue' }, { value: '#2DD4BF', label: 'Turquoise' },
]

const open = ref(false)
// The swatch is decorative, so the palette's own name labels the trigger.
const selectedLabel = computed(() => COLORS.find((c) => c.value === (selected.value ?? null))?.label ?? selected.value ?? 'None')

function pick(value: string | null) {
  selected.value = value
  open.value = false
}
</script>

<template>
  <Popover v-model:open="open" :disabled="disabled">
    <template #trigger>
      <button type="button" class="trigger" :disabled="disabled" :aria-label="`Colour: ${selectedLabel}`" :aria-expanded="open"
              aria-haspopup="listbox" data-testid="color-select-trigger">
        <span class="sw" :class="{ none: !selected }" :style="selected ? { background: selected } : undefined" />
      </button>
    </template>
    <div class="grid" role="listbox" aria-label="Colours">
      <button v-for="c in COLORS" :key="String(c.value)" type="button" class="opt" role="option" :class="{ on: c.value === (selected ?? null) }"
              :aria-selected="c.value === (selected ?? null)" :aria-label="c.label" :title="c.label" @click="pick(c.value)">
        <span class="sw" :class="{ none: !c.value }" :style="c.value ? { background: c.value } : undefined" />
      </button>
    </div>
  </Popover>
</template>

<style scoped>
.trigger {
  width: var(--target); height: var(--target); flex: none; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--gray-175); border-radius: var(--radius); background: var(--surface);
}
.trigger:hover:not(:disabled) { background: var(--surface-2); }
.trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.sw { width: 16px; height: 16px; border-radius: 4px; }
.sw.none { border: 1px dashed var(--border-strong); }
.grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; padding: 6px; }
.opt { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: var(--radius); background: transparent; }
.opt:hover { background: var(--surface-2); }
.opt.on { border-color: var(--accent); }
</style>
