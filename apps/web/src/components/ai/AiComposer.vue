<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { requireServices } from '../../app'
import { SLASH_COMMANDS, type SlashCommand } from '../../ai/commands'
import { AI_DOCK_KEY, chipKey, type ComposeRequest } from '../../ai/dock'
import type { ContextChip, UserMessage } from '../../ai/protocol'
import type { AiSession } from '../../ai/session'
import type { IconName } from '../../icons'
import { NOTEBOOK_KEY, type NotebookController } from '../../notebook'
import { diagnostics } from '../../services/diagnostics'
import { isImageFile, pickImageFiles, storeImageFile } from '../../services/images'
import { toastError } from '../../services/toast'
import Icon from '../Icon.vue'
import Popover from '../Popover.vue'
import AiPending from './AiPending.vue'

const props = defineProps<{ session: AiSession }>()
const dock = inject(AI_DOCK_KEY)!
/** null in the library dock: no page or selection chips, only notebook mentions. */
const ctl = inject<NotebookController | null>(NOTEBOOK_KEY, null)
const { workspace: ws } = requireServices()

interface DraftChip { key: string; chip: ContextChip }
interface Attachment { key: string; assetId: string | null; url: string; state: 'uploading' | 'ready' | 'error' }
type MenuEntry =
  | { kind: 'command'; key: string; label: string; hint: string; icon: IconName; command: SlashCommand }
  | { kind: 'mention'; key: string; label: string; hint: string; icon: IconName; chipKind: ContextChip['kind']; ref: ContextChip['ref'] }

const text = ref('')
const caret = ref(0)
const command = shallowRef<SlashCommand | null>(null)
const autoChips = shallowRef<DraftChip[]>([])
const mentions = shallowRef<DraftChip[]>([])
const removed = ref(new Set<string>())
const attachments = ref<Attachment[]>([])
const input = ref<HTMLTextAreaElement | null>(null)
const presetOpen = ref(false)
const dragging = ref(false)

const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
const session = computed(() => props.session)
const busy = computed(() => session.value.busy.value)
const pending = computed(() => session.value.pending.value)
const readOnly = computed(() => session.value.readOnly.value)
const queued = computed(() => session.value.queued.value)
const preset = computed(() => dock.preset.value)
const presets = computed(() => dock.config.value?.presets ?? [])
const hasImages = computed(() => attachments.value.some((a) => a.state === 'ready'))
const uploading = computed(() => attachments.value.some((a) => a.state === 'uploading'))
const visionBlocked = computed(() => attachments.value.length > 0 && preset.value?.vision === false)
const canSend = computed(() => !readOnly.value && !uploading.value && !visionBlocked.value && (!!text.value.trim() || !!command.value || hasImages.value))
const chips = computed(() => {
  const auto = autoChips.value.filter((c) => !removed.value.has(c.key))
  const shown = new Set(auto.map((c) => c.key))
  return [...auto, ...mentions.value.filter((m) => !shown.has(m.key))]
})

const credit = computed(() => {
  const c = dock.credit.value
  if (!c) return null
  const left = Math.max(0, c.limitUsd - c.usedUsd)
  const at = new Date(c.resetsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return { text: `$${left.toFixed(2)} left`, title: `Daily AI credit: $${left.toFixed(2)} of $${c.limitUsd.toFixed(2)} left. Resets at ${at}.`, low: left < c.limitUsd * 0.1 }
})

const placeholder = computed(() => {
  if (readOnly.value) return 'Running on another device'
  if (busy.value) return 'Add to the running turn…'
  return 'Ask anything, @ to mention, / for commands'
})

// ---- automatic page and selection chips -------------------------------------------

let autoSeq = 0
let autoTimer: ReturnType<typeof setTimeout> | undefined
async function refreshAuto(): Promise<void> {
  const my = ++autoSeq
  const host = session.value.host
  const view = host.view()
  const out: DraftChip[] = []
  if (view) {
    const { contextBuilder } = dock.tools
    try {
      const page = await contextBuilder.pageChip(host)
      if (page) out.push({ key: chipKey(page), chip: page })
      if (view.selection.length) {
        const sel = await contextBuilder.selectionChip(host)
        if (sel) out.push({ key: chipKey(sel), chip: sel })
      }
    } catch (e) {
      diagnostics.log('ai.chips', e)
    }
  }
  if (my === autoSeq) autoChips.value = out
}
function scheduleAuto() {
  clearTimeout(autoTimer)
  autoTimer = setTimeout(() => void refreshAuto(), 250)
}
watch([() => ctl?.pageId.value, () => ctl?.selection.value, session], scheduleAuto, { immediate: true })
onBeforeUnmount(() => {
  clearTimeout(autoTimer)
  for (const a of attachments.value) if (a.url) URL.revokeObjectURL(a.url)
})

function removeChip(c: DraftChip) {
  mentions.value = mentions.value.filter((m) => m.key !== c.key)
  if (autoChips.value.some((a) => a.key === c.key)) removed.value = new Set([...removed.value, c.key])
}

const CHIP_ICONS: Record<ContextChip['kind'], IconName> = {
  page: 'doc', selection: 'select', frame: 'frame', notebook: 'notebook', prompt_note: 'note',
}

// ---- / and @ menu --------------------------------------------------------------------

const trigger = computed(() => {
  const before = text.value.slice(0, caret.value)
  const slash = !command.value && /^\/([\w-]*)$/.exec(before)
  if (slash) return { kind: 'command' as const, query: slash[1].toLowerCase(), start: 0 }
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { kind: 'mention' as const, query: at[1].toLowerCase(), start: before.length - at[1].length - 1 }
  return null
})
const dismissedAt = ref<number | null>(null)
const active = ref(0)

const pages = computed(() => ctl?.pages.value ?? [])
const pageLabel = (i: number) => pages.value[i]?.title || `Page ${i + 1}`
const entries = computed<MenuEntry[]>(() => {
  const t = trigger.value
  if (!t || dismissedAt.value === t.start) return []
  const q = t.query
  if (t.kind === 'command') {
    return SLASH_COMMANDS.filter((c) => c.id.startsWith(q) || c.label.toLowerCase().includes(q))
      .map((c) => ({ kind: 'command', key: c.id, label: c.label, hint: c.hint, icon: 'sparkles', command: c }))
  }
  const out: MenuEntry[] = []
  const nb = ctl?.id ?? null
  pages.value.forEach((p, i) => {
    if (!nb) return
    out.push({ kind: 'mention', key: `page:${p.id}`, label: pageLabel(i), hint: 'Page', icon: 'doc', chipKind: 'page', ref: { notebookId: nb, pageId: p.id } })
  })
  pages.value.forEach((p, i) => {
    if (!ctl || !nb) return
    for (const o of ctl.doc.objects(p.id)) {
      if (o.type !== 'shape' || o.kind !== 'frame' || o.supersededBy) continue
      out.push({ kind: 'mention', key: `frame:${o.id}`, label: o.label || 'Frame', hint: pageLabel(i), icon: 'frame', chipKind: 'frame', ref: { notebookId: nb, pageId: p.id, objectIds: [o.id] } })
    }
  })
  for (const n of ws.notebooks()) {
    if (n.id === nb || n.deleted) continue
    out.push({ kind: 'mention', key: `nb:${n.id}`, label: n.title || 'Untitled', hint: 'Notebook', icon: 'notebook', chipKind: 'notebook', ref: { notebookId: n.id } })
  }
  return out.filter((e) => !q || e.label.toLowerCase().includes(q)).slice(0, 8)
})
watch(entries, () => { active.value = 0 })

async function pick(e: MenuEntry) {
  const t = trigger.value
  if (!t) return
  const rest = text.value.slice(caret.value)
  text.value = text.value.slice(0, t.start) + rest.replace(/^ /, t.start ? ' ' : '')
  caret.value = t.start
  await nextTick()
  input.value?.setSelectionRange(t.start, t.start)
  input.value?.focus()
  if (e.kind === 'command') {
    command.value = e.command
    return
  }
  if (mentions.value.some((m) => m.key === e.key)) return
  try {
    const chip = await dock.tools.contextBuilder.mentionChip(session.value.host, e.ref, e.chipKind)
    mentions.value = [...mentions.value, { key: e.key, chip }]
  } catch (err) {
    diagnostics.log('ai.mention', err)
    toastError(`Could not add “${e.label}”.`)
  }
}

// ---- attachments -------------------------------------------------------------------

let attachSeq = 0
async function addFiles(files: File[]) {
  for (const file of files.filter(isImageFile)) {
    const a: Attachment = { key: `a${++attachSeq}`, assetId: null, url: URL.createObjectURL(file), state: 'uploading' }
    attachments.value = [...attachments.value, a]
    const update = (patch: Partial<Attachment>) => {
      attachments.value = attachments.value.map((x) => (x.key === a.key ? { ...x, ...patch } : x))
    }
    try {
      const stored = await storeImageFile(ws, file)
      await dock.api.uploadAsset(stored.assetId, file)
      update({ assetId: stored.assetId, state: 'ready' })
    } catch (e) {
      update({ state: 'error' })
      toastError(e instanceof Error ? e.message : 'Could not upload the image.')
    }
  }
}
function removeAttachment(a: Attachment) {
  if (a.url) URL.revokeObjectURL(a.url)
  attachments.value = attachments.value.filter((x) => x !== a)
}
async function pickFiles() { await addFiles(await pickImageFiles()) }
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])].filter(isImageFile)
  if (!files.length) return
  e.preventDefault()
  void addFiles(files)
}
function onDrop(e: DragEvent) {
  dragging.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) void addFiles(files)
}

// ---- typing and sending ------------------------------------------------------------

function syncCaret() { caret.value = input.value?.selectionStart ?? text.value.length }
function autosize() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}
watch(text, () => void nextTick(autosize))

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return
  if (entries.value.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = entries.value.length
      active.value = (active.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      void pick(entries.value[active.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      dismissedAt.value = trigger.value?.start ?? null
      return
    }
  }
  if (e.key === 'Backspace' && command.value && input.value?.selectionStart === 0 && input.value.selectionEnd === 0) {
    command.value = null
    return
  }
  if (e.key === 'Enter' && !e.shiftKey && !coarse) {
    e.preventDefault()
    void submit()
  }
}
watch(trigger, (t) => { if (!t) dismissedAt.value = null })

async function submit() {
  if (!canSend.value) return
  const cmd = command.value
  const extra = text.value.trim()
  await refreshAuto()
  const message: UserMessage = {
    text: cmd ? [cmd.prompt, extra].filter(Boolean).join('\n\n') : extra,
    attachments: attachments.value.flatMap((a) => (a.state === 'ready' && a.assetId ? [a.assetId] : [])),
    context: chips.value.map((c) => c.chip),
    ...(cmd ? { command: cmd.id } : {}),
  }
  session.value.send(message)
  text.value = ''
  command.value = null
  mentions.value = []
  for (const a of attachments.value) if (a.url) URL.revokeObjectURL(a.url)
  attachments.value = []
}

async function stop() {
  const restored = await session.value.cancel()
  if (restored && !text.value.trim()) text.value = restored
}

/** Put a reverted message back for editing. */
function restore(m: UserMessage) {
  const cmd = SLASH_COMMANDS.find((c) => c.id === m.command) ?? null
  command.value = cmd
  text.value = cmd && m.text.startsWith(cmd.prompt) ? m.text.slice(cmd.prompt.length).trim() : m.text
  mentions.value = m.context
    .filter((c) => c.kind !== 'page' && c.kind !== 'selection')
    .map((chip, i) => ({ key: `restored:${i}:${chip.label}`, chip }))
  attachments.value = m.attachments.map((assetId) => ({ key: `a${++attachSeq}`, assetId, url: '', state: 'ready' }))
  void nextTick(() => input.value?.focus())
}
function focus() { input.value?.focus() }

/** Take an entry point's request: its chips (shown again if removed) and text, then focus or send. */
async function take(req: ComposeRequest) {
  dock.request.value = null
  const fresh = req.chips.map((chip) => ({ key: chipKey(chip), chip }))
  const keys = new Set(fresh.map((c) => c.key))
  removed.value = new Set([...removed.value].filter((k) => !keys.has(k)))
  mentions.value = [...mentions.value.filter((m) => !keys.has(m.key)), ...fresh]
  if (req.text) text.value = req.text
  await nextTick()
  focus()
  if (req.send) await submit()
}
watch(() => dock.request.value, (req) => { if (req) void take(req) }, { immediate: true })
/** Starter chips send a command right away. */
function runCommand(c: SlashCommand) {
  command.value = c
  text.value = ''
  void submit()
}
defineExpose({ restore, focus, runCommand })
</script>

<template>
  <div class="composer" :class="{ dragging }" data-testid="ai-composer"
       @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="onDrop">
    <ul v-if="entries.length" class="menu panel floating" role="listbox" data-testid="ai-menu">
      <li v-for="(e, i) in entries" :key="e.key" role="option" :aria-selected="i === active">
        <button class="entry" :class="{ on: i === active }" @pointerdown.prevent @click="pick(e)" @pointerenter="active = i">
          <Icon :name="e.icon" :size="15" />
          <span class="entry-label">{{ e.label }}</span>
          <span class="entry-hint">{{ e.hint }}</span>
        </button>
      </li>
    </ul>

    <div v-if="queued.length" class="queued" data-testid="ai-queued">
      <p v-for="(q, i) in queued" :key="i"><span class="q-tag">Queued</span>{{ q.text }}</p>
    </div>

    <div class="box panel">
      <AiPending v-if="pending" :pending="pending" @answer="session.answer($event)" />
      <template v-else>
        <div v-if="command || chips.length || attachments.length" class="chips">
          <span v-if="command" class="chip-x cmd" data-testid="ai-command-chip">
            <Icon name="sparkles" :size="12" /><span class="chip-label">{{ command.label }}</span>
            <button aria-label="Remove command" @click="command = null"><Icon name="x" :size="12" /></button>
          </span>
          <span v-for="c in chips" :key="c.key" class="chip-x" data-testid="ai-chip">
            <Icon :name="CHIP_ICONS[c.chip.kind]" :size="12" /><span class="chip-label">{{ c.chip.label }}</span>
            <button :aria-label="`Remove ${c.chip.label}`" @click="removeChip(c)"><Icon name="x" :size="12" /></button>
          </span>
          <span v-for="a in attachments" :key="a.key" class="thumb" :class="a.state" data-testid="ai-attachment">
            <img v-if="a.url" :src="a.url" alt="" />
            <Icon v-else name="image" :size="16" />
            <button aria-label="Remove image" @click="removeAttachment(a)"><Icon name="x" :size="11" /></button>
          </span>
        </div>
        <textarea ref="input" v-model="text" rows="1" :placeholder="placeholder" :disabled="readOnly" aria-label="Message the AI" data-testid="ai-input"
                  @keydown="onKeydown" @input="syncCaret" @click="syncCaret" @keyup="syncCaret" @paste="onPaste" />
        <p v-if="visionBlocked" class="warn">{{ preset?.label }} cannot see images. Pick another preset or remove them.</p>
        <div class="bar">
          <button class="icon-btn" aria-label="Attach images" title="Attach images" :disabled="readOnly" data-testid="ai-attach" @click="pickFiles">
            <Icon name="paperclip" :size="16" />
          </button>
          <Popover v-model:open="presetOpen" :disabled="!presets.length">
            <template #trigger>
              <button class="preset" :disabled="!presets.length" title="Model preset" data-testid="ai-preset">
                {{ preset?.label ?? 'Preset' }}<Icon name="down" :size="13" />
              </button>
            </template>
            <template #default="{ close }">
              <div class="presets" role="listbox" aria-label="Model preset">
                <button v-for="p in presets" :key="p.id" class="preset-row" :class="{ on: p.id === preset?.id }" role="option" :aria-selected="p.id === preset?.id"
                        @click="dock.setPreset(p.id); close()">
                  <span class="p-label">{{ p.label }}<Icon v-if="p.id === preset?.id" name="check" :size="14" /></span>
                  <span class="p-hint">{{ p.hint }}</span>
                </button>
              </div>
            </template>
          </Popover>
          <span v-if="credit" class="credit" :class="{ low: credit.low }" :title="credit.title" data-testid="ai-credit">{{ credit.text }}</span>
          <span class="spacer" />
          <button v-if="busy" class="icon-btn stop" aria-label="Stop" title="Stop" data-testid="ai-stop" @click="stop"><Icon name="stop" :size="14" /></button>
          <button class="icon-btn send" :class="{ ready: canSend }" :disabled="!canSend" :aria-label="busy ? 'Queue message' : 'Send'" :title="busy ? 'Queue for the next step' : 'Send'"
                  data-testid="ai-send" @click="submit">
            <Icon name="send" :size="16" />
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.composer { position: relative; padding: 0 10px calc(10px + var(--safe-bottom)); }
.box { display: flex; flex-direction: column; border-radius: var(--radius-lg); box-shadow: none; border-color: var(--border-strong); }
.box:focus-within { border-color: var(--accent); }
.composer.dragging .box { border-color: var(--accent); border-style: dashed; }
textarea {
  display: block; width: 100%; min-height: 40px; max-height: 200px; resize: none; border: 0; outline: none; background: transparent;
  padding: 10px 12px 4px; font-size: 14px; line-height: 1.45; color: var(--text-strong);
}
textarea::placeholder { color: var(--muted); }
textarea:disabled { cursor: not-allowed; }
.bar { display: flex; align-items: center; gap: 4px; padding: 4px 6px 6px; }
.bar .icon-btn { width: 30px; height: 30px; color: var(--muted); }
.bar .icon-btn:hover:not(:disabled) { color: var(--text-strong); }
.send.ready { background: var(--accent); color: var(--accent-text); }
.send.ready:hover { background: var(--accent-strong); color: var(--accent-text); }
.stop { border: 1px solid var(--border-strong); }
.preset { display: inline-flex; align-items: center; gap: 2px; min-height: 30px; padding: 0 6px 0 8px; border: 0; border-radius: 6px; background: none; color: var(--muted); font-size: 13px; }
.preset:hover:not(:disabled) { background: var(--surface-2); color: var(--text-strong); }
.credit { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.credit.low { color: var(--warn); }
.warn { margin: 0; padding: 0 12px 4px; font-size: 12.5px; color: var(--warn); }

.chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 8px 0; }
.chip-x { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; min-height: 24px; padding: 0 2px 0 7px; border-radius: 6px; background: var(--surface-2); color: var(--text); font-size: 12.5px; }
.chip-x.cmd { background: var(--accent-soft); color: var(--accent-strong); }
.chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.chip-x button { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: 0; border-radius: 4px; background: none; color: var(--muted); padding: 0; }
.chip-x button:hover { background: var(--surface-3); color: var(--text-strong); }
.thumb { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 6px; overflow: hidden; background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb.uploading img { opacity: 0.45; }
.thumb.error { border-color: var(--danger); }
.thumb button { position: absolute; top: 2px; right: 2px; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 4px; background: rgba(10, 10, 20, 0.6); color: #fff; }

.queued { display: flex; flex-direction: column; gap: 2px; padding: 0 4px 6px; }
.queued p { margin: 0; font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q-tag { margin-right: 6px; color: var(--accent-strong); font-weight: 600; }

.menu { position: absolute; left: 10px; right: 10px; bottom: calc(100% - 4px); z-index: 5; list-style: none; margin: 0; padding: 4px; max-height: 280px; overflow: auto; }
.entry { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px; padding: 0 8px; border: 0; border-radius: 6px; background: none; color: var(--text); text-align: left; font-size: 13.5px; }
.entry.on { background: var(--surface-2); color: var(--text-strong); }
.entry-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-hint { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--muted); }

.presets { display: flex; flex-direction: column; padding: 4px; min-width: 220px; }
.preset-row { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 10px; border: 0; border-radius: 6px; background: none; text-align: left; }
.preset-row:hover { background: var(--surface-2); }
.p-label { display: flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 600; color: var(--text-strong); }
.p-hint { font-size: 12.5px; color: var(--muted); }
@media (pointer: coarse) { .bar .icon-btn { width: 36px; height: 36px; } }
</style>
