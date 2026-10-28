<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { requireServices } from '../../app'
import { AI_DOCK_KEY } from '../../ai/dock'
import type { AiSession } from '../../ai/session'
import { NOTEBOOK_KEY, type NotebookController } from '../../notebook'
import { diagnostics } from '../../services/diagnostics'
import { findPromptNotes, type PromptNote } from '../../services/prompt-notes'
import { toastError } from '../../services/toast'
import Icon from '../Icon.vue'

/**
 * "Run" pills beside `@ai` handwriting on the current page, following the camera. They show only once the
 * pen has been idle and recognition has settled, so they never get in the way of writing. Nothing runs
 * without a tap; afterwards the pill becomes a badge that opens the thread (the link is the thread's source note).
 */
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const dock = inject(AI_DOCK_KEY)!
const { recognition } = requireServices()

/** Quiet time after the last pen or finger on the canvas before pills appear. */
const SETTLE_MS = 1500

const notes = shallowRef<PromptNote[]>([])
const settled = ref(false)
const cameraTick = ref(0)
/** Notes tapped in this visit, with the session that runs them. */
const runs = shallowRef(new Map<string, AiSession>())

let pointers = 0
let timer: ReturnType<typeof setTimeout> | undefined
function arm() {
  clearTimeout(timer)
  timer = setTimeout(check, SETTLE_MS)
}
function check() {
  if (pointers > 0 || recognition.busy.value > 0 || ctl.editingText.value) return arm()
  notes.value = findPromptNotes(ctl.doc, ctl.pageId.value)
  settled.value = true
}
const onDown = () => { pointers++; settled.value = false; clearTimeout(timer) }
const onUp = () => { pointers = Math.max(0, pointers - 1); arm() }

watch(() => ctl.editor.value, (e, _old, onCleanup) => {
  if (!e) return
  const root = e.root
  root.addEventListener('pointerdown', onDown, true)
  root.addEventListener('pointerup', onUp, true)
  root.addEventListener('pointercancel', onUp, true)
  const offCamera = e.on('camera', () => { cameraTick.value++ })
  const offDoc = ctl.doc.subscribe((ev) => { if (ev.pageIds.has(ctl.pageId.value)) arm() })
  arm()
  onCleanup(() => {
    root.removeEventListener('pointerdown', onDown, true)
    root.removeEventListener('pointerup', onUp, true)
    root.removeEventListener('pointercancel', onUp, true)
    offCamera()
    offDoc()
  })
}, { immediate: true })
watch(ctl.pageId, () => { notes.value = []; arm() })
watch(dock.disabledReason, () => {
  dock.loadNoteThreads().catch((err) => diagnostics.log('ai.promptNote', err))
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))

type PillState = 'run' | 'running' | 'done'
function stateOf(key: string): PillState {
  const s = runs.value.get(key)
  if (s?.busy.value) return 'running'
  if (dock.noteThreads.value.has(key)) return 'done'
  // between the tap and the first request; a failure before the thread existed offers Run again
  return s && !s.failure.value ? 'running' : 'run'
}

const pills = computed(() => {
  void cameraTick.value
  const e = ctl.editor.value
  if (!e || !settled.value || dock.disabledReason.value) return []
  const { width, height } = e.viewportSize
  return notes.value.flatMap((note) => {
    const b = note.bounds
    const p = e.worldToScreen({ x: b.x + b.width, y: b.y })
    const x = p.x + 8
    const y = p.y + Math.min(b.height * e.zoom, 44) / 2 - 13
    if (x > width || y > height || x < -80 || y < -26) return []
    return [{ note, x, y, state: stateOf(note.key) }]
  })
})

async function run(note: PromptNote) {
  if (stateOf(note.key) !== 'run') return
  try {
    const target = { notebookId: ctl.id, pageId: ctl.pageId.value, objectIds: note.strokeIds }
    const chip = await dock.tools.contextBuilder.mentionChip(dock.session.value.host, target, 'prompt_note')
    const s = await dock.compose({ fresh: true, text: note.text, chips: [chip], send: true, sourceNote: note.key })
    if (s) runs.value = new Map(runs.value).set(note.key, s)
  } catch (err) {
    diagnostics.log('ai.promptNote', err)
    toastError('Could not send the note to the AI.')
  }
}

async function open(note: PromptNote) {
  const id = dock.noteThreads.value.get(note.key)
  if (!id) return
  dock.setOpen(true)
  try {
    await dock.openThread(id)
  } catch {
    toastError('That thread no longer exists.')
  }
}
</script>

<template>
  <div class="prompt-notes" aria-live="polite">
    <template v-for="p in pills" :key="p.note.key">
      <button v-if="p.state === 'done'" class="badge" :style="{ transform: `translate(${p.x}px, ${p.y}px)` }" :title="`Open the AI thread for “${p.note.text}”`"
              data-testid="prompt-note-done" @click="open(p.note)">
        <Icon name="check" :size="14" /><span>Done</span>
      </button>
      <button v-else class="pill" :class="p.state" :disabled="p.state === 'running'" :style="{ transform: `translate(${p.x}px, ${p.y}px)` }"
              :title="p.state === 'run' ? `Ask the AI: ${p.note.text}` : 'The AI is working on this note'" data-testid="prompt-note-run" @click="run(p.note)">
        <Icon name="sparkles" :size="14" /><span>{{ p.state === 'run' ? 'Run' : 'Running' }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.prompt-notes { position: absolute; inset: 0; z-index: 15; overflow: hidden; pointer-events: none; }
.pill, .badge {
  position: absolute; top: 0; left: 0; display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px 0 8px;
  font-size: 12.5px; font-weight: 600; pointer-events: auto; box-shadow: var(--shadow-sm); animation: appear 0.18s ease-out;
}
.pill { border: 0; border-radius: 99px; background: var(--ai); color: #fff; }
.pill:hover:not(:disabled) { filter: brightness(1.08); }
.pill.running { background: var(--surface); color: var(--ai); border: 1px solid var(--ai); cursor: progress; }
.pill.running :deep(svg) { animation: pulse 1.2s ease-in-out infinite; }
.badge { border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--text); }
.badge :deep(svg) { color: var(--ok); }
.badge:hover { background: var(--surface-2); color: var(--text-strong); }
@media (pointer: coarse) { .pill, .badge { height: 32px; padding: 0 12px 0 10px; } }
@keyframes appear { from { opacity: 0; } }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .pill, .badge, .pill.running :deep(svg) { animation: none; } }
</style>
