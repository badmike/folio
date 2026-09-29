<script setup lang="ts">
import type { Tool } from '@folio/editor'
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import Icon from './Icon.vue'
import ToolOptions from './ToolOptions.vue'

const props = defineProps<{ placement: 'top' | 'bottom' }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const showOptions = ref(false)

const TOOLS: { tool: Tool; icon: string; label: string }[] = [
  { tool: 'select', icon: 'select', label: 'Select' },
  { tool: 'pen', icon: 'pen', label: 'Pen' },
  { tool: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
  { tool: 'eraser', icon: 'eraser', label: 'Eraser' },
  { tool: 'shape', icon: 'shape', label: 'Shape' },
  { tool: 'arrow', icon: 'arrow', label: 'Arrow' },
  { tool: 'text', icon: 'text', label: 'Text' },
]
const shapeIcon = computed(() => (ctl.options.value?.shape.kind ?? 'rectangle'))
const iconFor = (t: { tool: Tool; icon: string }) =>
  t.tool === 'shape' ? shapeIcon.value : t.tool === 'select' && ctl.options.value?.select.mode === 'lasso' ? 'lasso' : t.icon

function pick(t: Tool) {
  if (ctl.tool.value === t) showOptions.value = !showOptions.value
  else {
    ctl.setTool(t)
    showOptions.value = false
  }
}

const root = ref<HTMLElement | null>(null)
function onOutside(e: PointerEvent) {
  if (showOptions.value && root.value && !root.value.contains(e.target as Node)) showOptions.value = false
}
onMounted(() => document.addEventListener('pointerdown', onOutside, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))
</script>

<template>
  <div ref="root" class="dock" :class="props.placement" data-testid="toolbar">
    <div v-if="showOptions" class="pop"><ToolOptions /></div>
    <div class="bar panel" role="toolbar" aria-label="Tools">
      <button v-for="t in TOOLS" :key="t.tool" class="icon-btn" :class="{ active: ctl.tool.value === t.tool }"
              :aria-label="t.label" :aria-pressed="ctl.tool.value === t.tool" :title="t.label" :data-testid="`tool-${t.tool}`" @click="pick(t.tool)">
        <Icon :name="iconFor(t)" />
      </button>
      <span class="sep" />
      <button class="icon-btn" aria-label="Undo" title="Undo" data-testid="undo" :disabled="!ctl.canUndo.value" @click="ctl.undo()"><Icon name="undo" /></button>
      <button class="icon-btn" aria-label="Redo" title="Redo" data-testid="redo" :disabled="!ctl.canRedo.value" @click="ctl.redo()"><Icon name="redo" /></button>
    </div>
  </div>
</template>

<style scoped>
.dock { position: absolute; left: 0; right: 0; margin: 0 auto; width: max-content; z-index: 20; display: flex; align-items: center; max-width: calc(100% - 16px); pointer-events: none; }
.dock > * { pointer-events: auto; }
.dock.bottom { bottom: calc(10px + var(--safe-bottom)); flex-direction: column-reverse; gap: 8px; }
.dock.top { top: calc(64px + var(--safe-top)); flex-direction: column; gap: 8px; }
.bar { display: flex; align-items: center; gap: 2px; padding: 4px; overflow-x: auto; max-width: 100%; scrollbar-width: none; }
.bar::-webkit-scrollbar { display: none; }
.sep { width: 1px; height: 26px; background: var(--border); margin: 0 4px; flex: none; }
.pop { align-self: center; }
</style>
