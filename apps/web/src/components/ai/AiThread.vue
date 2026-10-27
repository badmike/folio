<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue'
import { requireServices } from '../../app'
import { SLASH_COMMANDS } from '../../ai/commands'
import { AI_DOCK_KEY } from '../../ai/dock'
import type { AiSession } from '../../ai/session'
import { deriveTimeline, type ToolTarget } from '../../ai/timeline'
import type { TurnInfo } from '../../ai/protocol'
import { confirmDialog } from '../../services/dialogs'
import { diagnostics } from '../../services/diagnostics'
import { toastError } from '../../services/toast'
import Icon from '../Icon.vue'
import AiComposer from './AiComposer.vue'
import AiTimeline from './AiTimeline.vue'

const props = defineProps<{ session: AiSession }>()
const dock = inject(AI_DOCK_KEY)!
const { workspace: ws } = requireServices()
const composer = ref<InstanceType<typeof AiComposer> | null>(null)
const scroller = ref<HTMLElement | null>(null)

const rows = computed(() => {
  const s = props.session
  return deriveTimeline({
    items: s.items.value, turns: s.turns.value, phase: s.phase.value, activeTurnId: s.activeTurnId.value, startedAt: s.startedAt.value,
    deviceId: ws.deviceId, failure: s.failure.value, waiting: !!s.pending.value, maxSteps: dock.config.value?.limits.maxSteps,
  })
})
const busy = computed(() => props.session.busy.value)
const empty = computed(() => !rows.value.length && !props.session.loading.value)
/** Library threads have no page to act on: other copy, no starters. */
const library = dock.notebookId === null

/** Follow new output while the user is at the bottom; leave them alone when they scrolled up. */
let pinned = true
function onScroll() {
  const el = scroller.value
  if (el) pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
watch(rows, async () => {
  if (!pinned) return
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}, { flush: 'post' })
watch(() => props.session, () => { pinned = true; void nextTick(() => composer.value?.focus()) })

async function revert(itemId: string) {
  const ok = await confirmDialog({
    title: 'Revert to this message?',
    message: 'The AI’s edits from this message on are undone, and the conversation after it is removed. You can edit the message and send it again.',
    confirmLabel: 'Revert',
    danger: true,
  })
  if (!ok) return
  try {
    const r = await props.session.revertTo(itemId)
    if (r) composer.value?.restore(r.message)
  } catch (e) {
    diagnostics.log('ai.revert', e)
    toastError(e instanceof Error ? e.message : 'Could not revert.')
  }
}
function retry(turnId: string | null) { props.session.retry(turnId) }
function resume(turn: TurnInfo) {
  void props.session.continueTurn(turn).catch((e) => toastError(e instanceof Error ? e.message : 'Could not continue.'))
}
function highlight(t: ToolTarget) { dock.host.highlight(t.notebookId, t.pageId, t.ids, true) }
defineExpose({ focus: () => composer.value?.focus() })
</script>

<template>
  <div class="thread">
    <div ref="scroller" class="scroll" @scroll.passive="onScroll">
      <div v-if="empty" class="empty" data-testid="ai-empty">
        <Icon name="sparkles" :size="22" />
        <h4>Ask about your notes</h4>
        <p v-if="library">The AI searches and reads your notebooks to answer here. It asks before it writes to a notebook.</p>
        <p v-else>The AI reads this notebook, answers here, and can draw, write and tidy up on the page. Every turn is one undo step.</p>
        <div v-if="!library" class="starters">
          <button v-for="c in SLASH_COMMANDS" :key="c.id" class="starter" :disabled="session.readOnly.value" :data-testid="`ai-starter-${c.id}`"
                  @click="composer?.runCommand(c)">
            <span class="s-label">{{ c.label }}</span>
            <span class="s-hint">{{ c.hint }}</span>
          </button>
        </div>
      </div>
      <AiTimeline v-else :rows="rows" :busy="busy" @revert="revert" @retry="retry" @continue="resume" @highlight="highlight" />
    </div>
    <AiComposer ref="composer" :session="session" />
  </div>
</template>

<style scoped>
.thread { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.empty { display: flex; flex-direction: column; gap: 6px; padding: 28px 18px 12px; color: var(--muted); }
.empty > :first-child { color: var(--ai); }
h4 { margin: 4px 0 0; font-size: 15px; font-weight: 650; color: var(--text-strong); }
.empty p { margin: 0 0 10px; font-size: 13.5px; line-height: 1.5; }
.starters { display: flex; flex-direction: column; gap: 4px; }
.starter {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 10px; text-align: left;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
}
.starter:hover:not(:disabled) { background: var(--surface-2); }
.starter:disabled { opacity: 0.5; cursor: not-allowed; }
.s-label { font-size: 13.5px; font-weight: 600; color: var(--text-strong); }
.s-hint { font-size: 12.5px; color: var(--muted); }
</style>
