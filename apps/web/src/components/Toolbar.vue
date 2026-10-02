<script setup lang="ts">
import type { Tool } from '@folio/editor'
import { computed, inject, ref } from 'vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import type { IconName } from '../icons'
import { hasKeyboard } from '../services/input-mode'
import Icon from './Icon.vue'

const props = defineProps<{ zen?: boolean; faded?: boolean }>()
const emit = defineEmits<{ (e: 'wake'): void }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!

/** Excalidraw order and letters; folio adds highlighter (M), note (N), counter (C) and blur (X). */
const TOOLS: { tool: Tool; icon: IconName; label: string; key: string; zen?: boolean }[] = [
  { tool: 'select', icon: 'select', label: 'Select', key: 'V', zen: true },
  { tool: 'hand', icon: 'hand', label: 'Hand', key: 'H' },
  { tool: 'pen', icon: 'pen', label: 'Pen', key: 'P', zen: true },
  { tool: 'highlighter', icon: 'highlighter', label: 'Highlighter', key: 'M', zen: true },
  { tool: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E', zen: true },
  { tool: 'shape', icon: 'shape', label: 'Shape', key: 'R' },
  { tool: 'arrow', icon: 'arrow', label: 'Arrow', key: 'A' },
  { tool: 'text', icon: 'text', label: 'Text', key: 'T' },
  { tool: 'note', icon: 'note', label: 'Note', key: 'N' },
  { tool: 'counter', icon: 'counter', label: 'Counter', key: 'C' },
  { tool: 'frame', icon: 'frame', label: 'Frame', key: 'F' },
  { tool: 'blur', icon: 'blur', label: 'Blur', key: 'X' },
]
/** Zen mode shows the drawing essentials; the chevron expands to all tools. */
const expanded = ref(false)
const tools = computed(() => (props.zen && !expanded.value ? TOOLS.filter((t) => t.zen) : TOOLS))
const shapeIcon = computed(() => (ctl.options.value?.shape.kind ?? 'rectangle'))
const iconFor = (t: { tool: Tool; icon: IconName }): IconName =>
  t.tool === 'shape' ? shapeIcon.value : t.tool === 'select' && ctl.options.value?.select.mode === 'lasso' ? 'lasso' : t.icon
const locked = ctl.locked

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
    class="dock" :class="{ zen, faded }" data-testid="toolbar"
    @pointerenter="emit('wake')" @pointerdown="emit('wake')"
  >
    <div v-if="locked" class="bar panel floating readonly" role="status" data-testid="locked-bar">
      <Icon name="lock" :size="18" />
      <span>Read only</span>
      <button class="btn small" data-testid="unlock" @click="ctl.setLocked(false)">Unlock</button>
    </div>
    <div v-else class="bar panel floating" role="toolbar" aria-label="Tools">
      <div class="tools" data-testid="toolbar-tools">
        <button
          class="icon-btn lock" :class="{ active: ctl.toolLock.value }" :aria-pressed="ctl.toolLock.value" aria-label="Keep selected tool active"
          :title="hasKeyboard ? 'Keep selected tool active after drawing (Q)' : 'Keep selected tool active after drawing'" data-testid="tool-lock" @click="ctl.setToolLock(!ctl.toolLock.value)"
        >
          <Icon :name="ctl.toolLock.value ? 'lock' : 'unlock'" :size="18" />
        </button>
        <span class="sep" />
        <button v-for="t in tools" :key="t.tool" class="icon-btn" :class="{ active: ctl.tool.value === t.tool }"
                :aria-label="t.label" :aria-pressed="ctl.tool.value === t.tool" :title="hasKeyboard ? `${t.label} (${t.key})` : t.label" :data-testid="`tool-${t.tool}`" @click="pick(t.tool)">
          <Icon :name="iconFor(t)" />
          <span v-if="!zen && hasKeyboard" class="key" aria-hidden="true">{{ t.key }}</span>
        </button>
        <button v-if="!zen || expanded" class="icon-btn" aria-label="Insert image" title="Insert image" data-testid="tool-image" @click="ctl.pickImages()">
          <Icon name="image" />
        </button>
        <button v-if="zen" class="icon-btn" :aria-label="expanded ? 'Fewer tools' : 'More tools'" :aria-expanded="expanded" data-testid="zen-more" @click="expanded = !expanded">
          <Icon :name="expanded ? 'chevleft' : 'right'" />
        </button>
      </div>
      <span class="sep" />
      <button class="icon-btn" aria-label="Undo" :title="hasKeyboard ? 'Undo (⌘Z)' : 'Undo'" data-testid="undo" :disabled="!ctl.canUndo.value" @click="ctl.undo()"><Icon name="undo" /></button>
      <button class="icon-btn" aria-label="Redo" :title="hasKeyboard ? 'Redo (⌘⇧Z)' : 'Redo'" data-testid="redo" :disabled="!ctl.canRedo.value" @click="ctl.redo()"><Icon name="redo" /></button>
    </div>
  </div>
</template>

<style scoped>
.dock { position: absolute; left: 0; right: 0; bottom: calc(8px + var(--safe-bottom)); margin: 0 auto; width: max-content; z-index: 20; display: flex; align-items: center; max-width: calc(100% - 16px); pointer-events: none; transition: opacity 0.35s; }
.dock > * { pointer-events: auto; }
.dock.zen .bar { background: color-mix(in srgb, var(--surface) 80%, transparent); backdrop-filter: blur(8px); }
.dock.faded { opacity: 0.18; }
/* Only the tools scroll when the bar is wider than the screen; undo and redo stay put. */
.bar { display: flex; align-items: center; gap: 1px; padding: 4px; max-width: 100%; }
.tools { display: flex; align-items: center; gap: 1px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.tools::-webkit-scrollbar { display: none; }
.bar .icon-btn { flex: none; width: 40px; height: 40px; border-radius: 6px; }
.bar .lock { width: 34px; }
.key { position: absolute; right: 4px; bottom: 2px; font-size: 9px; line-height: 1; color: var(--muted); font-weight: 600; opacity: 0.7; }
.icon-btn.active .key { color: var(--accent-strong); }
.sep { width: 1px; height: 24px; background: var(--border); margin: 0 3px; flex: none; }
.readonly { gap: 8px; padding: 4px 6px 4px 12px; color: var(--muted); font-size: 13.5px; }
@media (max-width: 720px) { .key { display: none; } }
</style>
