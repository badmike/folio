<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { SLASH_COMMANDS } from '../../ai/commands'
import type { ContextChip, TurnInfo, UserMessage } from '../../ai/protocol'
import type { TimelineRow, ToolRow, ToolTarget } from '../../ai/timeline'
import type { IconName } from '../../icons'
import Icon from '../Icon.vue'
import AiMarkdown from './AiMarkdown.vue'

const props = defineProps<{ rows: TimelineRow[]; busy: boolean }>()
const emit = defineEmits<{
  (e: 'revert', itemId: string): void
  (e: 'retry', turnId: string | null): void
  (e: 'continue', turn: TurnInfo): void
  (e: 'highlight', target: ToolTarget): void
}>()

const expanded = ref(new Set<string>())
function toggle(id: string) {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}

/** The working row's timer ticks only while a turn runs. */
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | undefined
watch(() => props.rows.some((r) => r.kind === 'working'), (on) => {
  clearInterval(tick)
  now.value = Date.now()
  if (on) tick = setInterval(() => { now.value = Date.now() }, 1000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(tick))

function elapsed(since: number): string {
  const s = Math.max(0, Math.floor((now.value - since) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const CHIP_ICONS: Record<ContextChip['kind'], IconName> = {
  page: 'doc', selection: 'select', frame: 'frame', notebook: 'notebook', prompt_note: 'note',
}
const commandOf = (m: UserMessage) => SLASH_COMMANDS.find((c) => c.id === m.command)
/** A command message shows its name, not the prompt behind it. */
function shownText(m: UserMessage): string {
  const c = commandOf(m)
  return c && m.text.startsWith(c.prompt) ? m.text.slice(c.prompt.length).trim() : m.text
}

function toolError(t: ToolRow): string {
  const out = t.result?.output
  if (t.state !== 'error') return ''
  if (typeof out === 'string') return out
  if (typeof out === 'object' && out !== null && typeof (out as { error?: unknown }).error === 'string') return (out as { error: string }).error
  return t.result ? '' : 'No result. The turn ended before this ran.'
}
</script>

<template>
  <div class="timeline" data-testid="ai-timeline">
    <template v-for="row in rows" :key="row.id">
      <div v-if="row.kind === 'user'" class="user" :class="{ local: row.local }" data-testid="ai-user-message">
        <div class="bubble selectable">
          <div v-if="row.message.command || row.message.context.length || row.message.attachments.length" class="tags">
            <span v-if="commandOf(row.message)" class="tag"><Icon name="sparkles" :size="12" />{{ commandOf(row.message)?.label }}</span>
            <span v-for="(c, i) in row.message.context" :key="i" class="tag"><Icon :name="CHIP_ICONS[c.kind]" :size="12" />{{ c.label }}</span>
            <span v-if="row.message.attachments.length" class="tag">
              <Icon name="image" :size="12" />{{ row.message.attachments.length === 1 ? '1 image' : `${row.message.attachments.length} images` }}
            </span>
          </div>
          <p v-if="shownText(row.message)" class="text">{{ shownText(row.message) }}</p>
        </div>
        <div v-if="!row.local" class="meta">
          <button class="mini" :disabled="busy" title="Undo the AI's edits from here on and edit this message again"
                  data-testid="ai-revert" @click="emit('revert', row.id)">
            <Icon name="undo" :size="13" /> Revert to this message
          </button>
        </div>
      </div>

      <AiMarkdown v-else-if="row.kind === 'assistant'" class="assistant" :class="{ streaming: row.streaming }" :text="row.text" data-testid="ai-assistant-message" />

      <div v-else-if="row.kind === 'tools'" class="tools" data-testid="ai-tools">
        <button class="tools-head" :aria-expanded="expanded.has(row.id)" @click="toggle(row.id)">
          <Icon :name="expanded.has(row.id) ? 'down' : 'right'" :size="14" />
          <span class="summary">{{ row.summary }}</span>
          <span v-if="row.running" class="spinner" aria-label="Running" />
        </button>
        <ul v-if="expanded.has(row.id)" class="tool-list">
          <li v-for="t in row.tools" :key="t.id">
            <button class="tool" :class="t.state" :disabled="!t.target" :title="t.target ? 'Show on the page' : undefined"
                    data-testid="ai-tool" @click="t.target && emit('highlight', t.target)">
              <span class="dot" />
              <span class="t-label">{{ t.label }}</span>
              <span v-if="toolError(t)" class="err">{{ toolError(t) }}</span>
            </button>
          </li>
        </ul>
      </div>

      <div v-else-if="row.kind === 'turn_end'" class="note" :class="row.state" data-testid="ai-turn-end">
        <Icon v-if="row.state === 'failed' || row.state === 'interrupted'" name="alert" :size="14" />
        <span class="msg">{{ row.message }}</span>
        <button v-if="row.state === 'failed'" class="btn small ghost" :disabled="busy" data-testid="ai-retry" @click="emit('retry', row.turn.id)">
          <Icon name="retry" :size="14" /> Retry
        </button>
        <button v-else-if="row.state === 'interrupted'" class="btn small ghost" :disabled="busy" data-testid="ai-continue" @click="emit('continue', row.turn)">
          <Icon name="play" :size="14" /> Continue
        </button>
      </div>

      <div v-else-if="row.kind === 'failure'" class="note failed" data-testid="ai-failure">
        <Icon name="alert" :size="14" />
        <span class="msg">{{ row.message }}</span>
        <button class="btn small ghost" :disabled="busy" data-testid="ai-retry" @click="emit('retry', null)"><Icon name="retry" :size="14" /> Retry</button>
      </div>

      <div v-else class="working" data-testid="ai-working">
        <span class="pulse" />
        <span>{{ row.label }}</span>
        <span class="time">{{ elapsed(row.since) }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.timeline { display: flex; flex-direction: column; gap: 12px; padding: 14px 14px 8px; }

.user { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.bubble { max-width: 88%; padding: 8px 12px; border-radius: var(--radius-lg); background: var(--surface-2); color: var(--text-strong); font-size: 14px; line-height: 1.5; }
.user.local .bubble { opacity: 0.7; }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
.tags:last-child { margin-bottom: 0; }
.tag { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 1px 6px; border-radius: 5px; background: var(--surface); color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { opacity: 0; transition: opacity 0.15s; }
.user:hover .meta, .meta:focus-within { opacity: 1; }
@media (pointer: coarse) { .meta { opacity: 1; } }
.mini { display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; padding: 2px 4px; border-radius: 5px; color: var(--muted); font-size: 12px; }
.mini:hover:not(:disabled) { color: var(--text-strong); background: var(--surface-2); }
.mini:disabled { opacity: 0.4; cursor: default; }

.assistant.streaming > :deep(:last-child::after) { content: ''; display: inline-block; width: 6px; height: 14px; margin-left: 2px; vertical-align: -2px; background: var(--ai); opacity: 0.6; animation: blink 1s steps(2) infinite; }

.tools { font-size: 13px; color: var(--muted); }
.tools-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 2px 0; border: 0; background: none; color: inherit; text-align: left; }
.tools-head:hover { color: var(--text-strong); }
.summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-list { list-style: none; margin: 4px 0 0; padding: 0 0 0 7px; border-left: 1px solid var(--border); display: flex; flex-direction: column; }
.tool { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; width: 100%; padding: 3px 8px; border: 0; border-radius: 5px; background: none; color: var(--text); text-align: left; font-size: 13px; }
.tool:hover:not(:disabled) { background: var(--surface-2); color: var(--text-strong); }
.tool:disabled { cursor: default; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; transform: translateY(-1px); }
.tool.running .dot { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
.tool.error .dot { background: var(--danger); }
.t-label { flex: 1; min-width: 0; }
.err { flex-basis: 100%; padding-left: 14px; color: var(--danger); font-size: 12px; }

.note { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 13px; color: var(--muted); }
.note.failed, .note.interrupted { color: var(--text-strong); }
.note.failed > :first-child { color: var(--danger); }
.note.interrupted > :first-child { color: var(--warn); }
.msg { flex: 1; min-width: 0; }
.note .btn.small { min-height: 28px; padding: 0 8px; font-size: 13px; gap: 4px; }

.working { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
.time { font-variant-numeric: tabular-nums; }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--ai); animation: pulse 1.2s ease-in-out infinite; }
.spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--border-strong); border-top-color: var(--accent); animation: spin 0.8s linear infinite; flex: none; }
@keyframes pulse { 50% { opacity: 0.35; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .pulse, .spinner, .tool.running .dot, .assistant.streaming > :deep(:last-child::after) { animation: none; } }
</style>
