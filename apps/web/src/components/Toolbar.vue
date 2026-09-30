<script setup lang="ts">
import type { Tool } from '@folio/editor'
import { computed, inject, ref } from 'vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import Icon from './Icon.vue'

const props = defineProps<{ placement: 'top' | 'bottom'; zen?: boolean; faded?: boolean }>()
const emit = defineEmits<{ (e: 'wake'): void }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!

const TOOLS: { tool: Tool; icon: string; label: string; zen?: boolean }[] = [
  { tool: 'select', icon: 'select', label: 'Select', zen: true },
  { tool: 'pen', icon: 'pen', label: 'Pen', zen: true },
  { tool: 'highlighter', icon: 'highlighter', label: 'Highlighter', zen: true },
  { tool: 'eraser', icon: 'eraser', label: 'Eraser', zen: true },
  { tool: 'shape', icon: 'shape', label: 'Shape' },
  { tool: 'arrow', icon: 'arrow', label: 'Arrow' },
  { tool: 'text', icon: 'text', label: 'Text' },
]
/** Zen mode shows the drawing essentials; the chevron expands to all tools. */
const expanded = ref(false)
const tools = computed(() => (props.zen && !expanded.value ? TOOLS.filter((t) => t.zen) : TOOLS))
const shapeIcon = computed(() => (ctl.options.value?.shape.kind ?? 'rectangle'))
const iconFor = (t: { tool: Tool; icon: string }) =>
  t.tool === 'shape' ? shapeIcon.value : t.tool === 'select' && ctl.options.value?.select.mode === 'lasso' ? 'lasso' : t.icon

/** Clicking the active tool again shows/hides its options (properties panel). */
function pick(t: Tool) {
  if (ctl.tool.value === t) ctl.showToolOptions.value = !ctl.showToolOptions.value
  else {
    ctl.showToolOptions.value = false
    ctl.setTool(t)
  }
}
</script>

<template>
  <div
    class="dock" :class="[props.placement, { zen, faded }]" data-testid="toolbar"
    @pointerenter="emit('wake')" @pointerdown="emit('wake')"
  >
    <div class="bar panel" role="toolbar" aria-label="Tools">
      <button v-for="t in tools" :key="t.tool" class="icon-btn" :class="{ active: ctl.tool.value === t.tool }"
              :aria-label="t.label" :aria-pressed="ctl.tool.value === t.tool" :title="t.label" :data-testid="`tool-${t.tool}`" @click="pick(t.tool)">
        <Icon :name="iconFor(t)" />
      </button>
      <button v-if="zen" class="icon-btn" :aria-label="expanded ? 'Fewer tools' : 'More tools'" :aria-expanded="expanded" data-testid="zen-more" @click="expanded = !expanded">
        <Icon :name="expanded ? 'chevleft' : 'right'" />
      </button>
      <span class="sep" />
      <button class="icon-btn" aria-label="Undo" title="Undo" data-testid="undo" :disabled="!ctl.canUndo.value" @click="ctl.undo()"><Icon name="undo" /></button>
      <button v-if="!zen" class="icon-btn" aria-label="Redo" title="Redo" data-testid="redo" :disabled="!ctl.canRedo.value" @click="ctl.redo()"><Icon name="redo" /></button>
    </div>
  </div>
</template>

<style scoped>
.dock { position: absolute; left: 0; right: 0; margin: 0 auto; width: max-content; z-index: 20; display: flex; align-items: center; max-width: calc(100% - 16px); pointer-events: none; transition: opacity 0.35s; }
.dock > * { pointer-events: auto; }
.dock.bottom { bottom: calc(10px + var(--safe-bottom)); }
.dock.top { top: calc(64px + var(--safe-top)); }
.dock.zen.top { top: calc(12px + var(--safe-top)); }
.dock.zen .bar { background: color-mix(in srgb, var(--surface) 78%, transparent); backdrop-filter: blur(8px); }
.dock.faded { opacity: 0.18; }
.bar { display: flex; align-items: center; gap: 2px; padding: 4px; overflow-x: auto; max-width: 100%; scrollbar-width: none; }
.bar::-webkit-scrollbar { display: none; }
.sep { width: 1px; height: 26px; background: var(--border); margin: 0 4px; flex: none; }
</style>
