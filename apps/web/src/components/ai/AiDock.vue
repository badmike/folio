<script setup lang="ts">
import { computed, inject, onBeforeUnmount, watch } from 'vue'
import { AI_DOCK_KEY } from '../../ai/dock'
import Icon from '../Icon.vue'
import AiThread from './AiThread.vue'
import AiThreadList from './AiThreadList.vue'

/** push: a column beside the canvas (wide screens). overlay: a floating sheet above it. */
const props = defineProps<{ mode: 'push' | 'overlay' }>()
const dock = inject(AI_DOCK_KEY)!
const session = computed(() => dock.session.value)
const listing = computed(() => dock.view.value === 'threads')
const title = computed(() => (listing.value ? 'Threads' : session.value.thread.value?.title || 'New thread'))
// signing in or coming back online while the dock is open: load config and the last thread now
watch(() => dock.disabledReason.value, (reason) => { if (!reason) dock.setOpen(true) })

let drag: { x: number; w: number } | null = null
function startResize(e: PointerEvent) {
  if (props.mode !== 'push') return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  drag = { x: e.clientX, w: dock.width.value }
}
function onResize(e: PointerEvent) {
  if (drag) dock.setWidth(drag.w + drag.x - e.clientX, false)
}
function endResize() {
  if (!drag) return
  drag = null
  dock.setWidth(dock.width.value)
}
function onGripKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') dock.setWidth(dock.width.value + 20)
  else if (e.key === 'ArrowRight') dock.setWidth(dock.width.value - 20)
}
onBeforeUnmount(() => { drag = null })
</script>

<template>
  <aside class="ai-dock" :class="mode" :style="mode === 'push' ? { width: `${dock.width.value}px` } : undefined" aria-label="AI assistant"
         data-testid="ai-dock" @pointerdown.stop>
    <div v-if="mode === 'push'" class="grip" role="separator" aria-orientation="vertical" aria-label="Resize the AI dock" tabindex="0"
         :aria-valuenow="dock.width.value" @pointerdown="startResize" @pointermove="onResize" @pointerup="endResize" @pointercancel="endResize" @keydown="onGripKey" />
    <header class="head">
      <button class="icon-btn" :class="{ active: listing }" :aria-label="listing ? 'Back to the thread' : 'All threads'" :title="listing ? 'Back to the thread' : 'All threads'"
              data-testid="ai-threads" @click="dock.view.value = listing ? 'thread' : 'threads'">
        <Icon :name="listing ? 'back' : 'threads'" :size="17" />
      </button>
      <h3 class="title" :title="title" data-testid="ai-title">{{ title }}</h3>
      <button class="icon-btn" aria-label="New thread" title="New thread" data-testid="ai-new" @click="dock.newThread()"><Icon name="edit" :size="16" /></button>
      <button class="icon-btn" aria-label="Close AI assistant" title="Close (⌘J)" data-testid="ai-close" @click="dock.setOpen(false)"><Icon name="x" :size="17" /></button>
    </header>
    <div v-if="dock.disabledReason.value" class="off" data-testid="ai-disabled">
      <Icon name="alert" :size="18" />
      <span>{{ dock.disabledReason.value }}</span>
    </div>
    <AiThreadList v-else-if="listing" />
    <AiThread v-else :key="session.key" :session="session" />
  </aside>
</template>

<style scoped>
.ai-dock { display: flex; flex-direction: column; overflow: hidden; background: var(--surface); }
.ai-dock.push {
  position: absolute; z-index: 20; top: 0; right: 0; bottom: 0; border-left: 1px solid var(--border);
  padding-top: var(--safe-top); padding-right: var(--safe-right);
}
.ai-dock.overlay {
  position: absolute; z-index: 30; top: calc(52px + var(--safe-top)); right: calc(8px + var(--safe-right)); bottom: calc(8px + var(--safe-bottom));
  width: min(400px, calc(100% - 16px)); border: 1px solid var(--popover-border); border-radius: var(--radius-lg); box-shadow: var(--shadow);
}
@media (max-width: 640px) {
  .ai-dock.overlay { left: calc(8px + var(--safe-left)); width: auto; top: auto; height: min(78%, 640px); }
}
.grip { position: absolute; z-index: 1; top: 0; bottom: 0; left: -3px; width: 7px; cursor: col-resize; touch-action: none; }
.grip:hover, .grip:focus-visible { background: linear-gradient(to right, transparent 3px, var(--accent) 3px, var(--accent) 4px, transparent 4px); outline: none; }
.head { display: flex; align-items: center; gap: 2px; min-height: 44px; padding: 4px 6px; border-bottom: 1px solid var(--border); }
.head .icon-btn { width: 32px; height: 32px; color: var(--muted); }
.head .icon-btn:hover { color: var(--text-strong); }
.head .icon-btn.active { color: var(--accent-strong); }
.title { flex: 1; min-width: 0; padding: 0 4px; font-size: 14px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.off { display: flex; gap: 8px; align-items: flex-start; margin: 14px; padding: 10px 12px; border-radius: var(--radius); background: var(--surface-2); font-size: 13.5px; line-height: 1.45; }
.off > :first-child { flex: none; color: var(--warn); }
</style>
