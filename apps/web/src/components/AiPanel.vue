<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { requireServices } from '../app'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import { AI_KINDS, AiError, aiDisabledReason, insertAiResult, runAi, type AiKind } from '../services/ai'
import { diagnostics } from '../services/diagnostics'
import { toast } from '../services/toast'
import Icon from './Icon.vue'
import Sheet from './Sheet.vue'

defineEmits<{ (e: 'close'): void }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const { auth } = requireServices()
const reason = computed(() => aiDisabledReason(auth))
const busy = ref<AiKind | null>(null)
const error = ref('')
const question = ref('')

async function run(kind: AiKind) {
  if (reason.value || busy.value) return
  busy.value = kind
  error.value = ''
  try {
    const md = await runAi(auth, ctl.doc, ctl.pageId.value, kind, question.value)
    insertAiResult(ctl.session, ctl.editor.value, ctl.pageId.value, md)
    toast('Added to the page. You can edit or undo it like any other text.', { kind: 'success' })
  } catch (e) {
    if (!(e instanceof AiError)) diagnostics.log('ai', e)
    error.value = e instanceof AiError ? e.message : 'Something went wrong.'
  } finally { busy.value = null }
}
</script>

<template>
  <Sheet title="AI assistant" @close="$emit('close')">
    <div v-if="reason" class="off" data-testid="ai-disabled"><Icon name="alert" :size="20" /> <span>{{ reason }}</span></div>
    <p class="muted intro">Results are added to the page as normal text you can edit. Only the text and structure of your notes is sent, never your ink.</p>
    <div class="kinds">
      <button v-for="k in AI_KINDS" :key="k.kind" class="btn kind" :disabled="!!reason || !!busy" :data-testid="`ai-${k.kind}`" @click="run(k.kind)">
        <Icon name="sparkles" :size="18" />
        <span class="t"><strong>{{ busy === k.kind ? 'Working…' : k.label }}</strong><small class="muted">{{ k.hint }}</small></span>
      </button>
    </div>
    <div class="ask">
      <h4>Ask my notes</h4>
      <form @submit.prevent="run('ask')">
        <input v-model="question" class="input" placeholder="What did I write about…?" :disabled="!!reason" aria-label="Question" data-testid="ai-question" />
        <button class="btn primary" type="submit" :disabled="!!reason || !!busy || !question.trim()" data-testid="ai-ask">{{ busy === 'ask' ? 'Thinking…' : 'Ask' }}</button>
      </form>
    </div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
  </Sheet>
</template>

<style scoped>
.off { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); margin-bottom: 12px; }
.intro { margin: 0 0 12px; font-size: 13px; }
.kinds { display: flex; flex-direction: column; gap: 8px; }
.kind { justify-content: flex-start; text-align: left; padding: 8px 12px; height: auto; }
.t { display: flex; flex-direction: column; white-space: normal; }
.t small { font-size: 12px; }
.ask { margin-top: 20px; }
h4 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
form { display: flex; gap: 8px; }
.err { color: var(--danger); margin-top: 12px; }
</style>
