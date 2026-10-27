<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AiApiError, type AiApi } from '../ai/api'
import { diagnostics } from '../services/diagnostics'

/** Custom AI instructions at one level (user, or one notebook), loaded from and saved to the server. */
const props = defineProps<{
  api: Pick<AiApi, 'instructions' | 'saveInstructions'>
  /** null for the user-level instructions. */
  notebookId: string | null
  label: string
  description: string
  /** Why AI is unavailable; disables the field. */
  disabledReason: string | null
}>()

const MAX = 4000
const text = ref('')
const stored = ref('')
const state = ref<'idle' | 'loading' | 'saving' | 'saved'>('idle')
const error = ref<string | null>(null)
/** The server said AI is not configured: the field stays disabled with that reason. */
const serverReason = ref<string | null>(null)

const reason = computed(() => props.disabledReason ?? serverReason.value)
const over = computed(() => text.value.length > MAX)
const dirty = computed(() => text.value !== stored.value)
const canSave = computed(() => !reason.value && dirty.value && !over.value && state.value !== 'saving' && state.value !== 'loading')
const id = `instructions-${props.notebookId ?? 'user'}`

function fail(e: unknown, what: string) {
  if (e instanceof AiApiError && e.code === 'ai_not_configured') serverReason.value = e.message
  else {
    if (!(e instanceof AiApiError)) diagnostics.log('ai.instructions', e)
    error.value = e instanceof Error ? e.message : `Could not ${what} the instructions.`
  }
}

async function load() {
  state.value = 'loading'
  error.value = null
  try {
    const res = await props.api.instructions(props.notebookId)
    stored.value = res.text
    text.value = res.text
  } catch (e) {
    fail(e, 'load')
  } finally {
    state.value = 'idle'
  }
}
watch(() => [props.disabledReason, props.notebookId], () => { if (!props.disabledReason) void load() }, { immediate: true })

async function save() {
  if (!canSave.value) return
  state.value = 'saving'
  error.value = null
  try {
    const res = await props.api.saveInstructions({ notebookId: props.notebookId, text: text.value.trim() })
    stored.value = res.text
    text.value = res.text
    state.value = 'saved'
  } catch (e) {
    fail(e, 'save')
    state.value = 'idle'
  }
}
watch(dirty, (d) => { if (d && state.value === 'saved') state.value = 'idle' })

const status = computed(() => {
  if (reason.value) return reason.value
  if (error.value) return error.value
  if (over.value) return `Shorten it to ${MAX} characters to save.`
  if (state.value === 'loading') return 'Loading…'
  if (state.value === 'saved') return 'Saved'
  return ''
})
</script>

<template>
  <div class="instructions" :data-testid="`instructions-${notebookId ? 'notebook' : 'user'}`">
    <div class="top">
      <label class="name" :for="id">{{ label }}</label>
      <span class="count" :class="{ over }" data-testid="instructions-count">{{ text.length }} / {{ MAX }}</span>
    </div>
    <p class="desc">{{ description }}</p>
    <textarea :id="id" v-model="text" class="input" rows="5" :maxlength="MAX" :disabled="!!reason || state === 'loading'"
              placeholder="For example: Answer in German. Keep summaries short. I study physics." data-testid="instructions-input" />
    <div class="foot">
      <span class="status" :class="{ warn: !!error || over, ok: state === 'saved' }" data-testid="instructions-status">{{ status }}</span>
      <button class="btn small" :disabled="!canSave" data-testid="instructions-save" @click="save">{{ state === 'saving' ? 'Saving…' : 'Save' }}</button>
    </div>
  </div>
</template>

<style scoped>
.instructions { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.top { display: flex; align-items: baseline; gap: 12px; }
.name { flex: 1; font-size: 14px; font-weight: 600; color: var(--text-strong); }
.count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.count.over { color: var(--danger); font-weight: 600; }
.desc { margin: 0; font-size: 13px; line-height: 1.45; color: var(--muted); }
textarea { width: 100%; min-height: 104px; resize: vertical; padding: 8px 10px; font: inherit; font-size: 14px; line-height: 1.45; }
textarea:disabled { opacity: 0.6; cursor: not-allowed; }
.foot { display: flex; align-items: center; gap: 12px; }
.status { flex: 1; min-width: 0; font-size: 12.5px; color: var(--muted); }
.status.warn { color: var(--warn); }
.status.ok { color: var(--ok); }
</style>
