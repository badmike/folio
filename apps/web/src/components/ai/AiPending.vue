<script setup lang="ts">
import { ref } from 'vue'
import type { ApprovalDecision, AskUserAnswer } from '../../ai/host'
import type { PendingRequest } from '../../ai/session'
import Icon from '../Icon.vue'

defineProps<{ pending: PendingRequest }>()
const emit = defineEmits<{ (e: 'answer', value: ApprovalDecision | AskUserAnswer): void }>()
const free = ref('')
function sendFree() {
  const t = free.value.trim()
  if (t) emit('answer', { text: t })
}
</script>

<template>
  <div v-if="pending.kind === 'approval'" class="pending" role="group" aria-label="Approval needed" data-testid="ai-approval">
    <p class="q"><Icon name="alert" :size="15" /><span>{{ pending.req.summary }}</span></p>
    <div class="actions">
      <button class="btn small ghost" data-testid="ai-deny" @click="emit('answer', 'deny')">Deny</button>
      <button v-if="pending.req.kind === 'other_notebook'" class="btn small" data-testid="ai-allow-thread" @click="emit('answer', 'thread')">Allow for this thread</button>
      <button class="btn small primary" data-testid="ai-allow-once" @click="emit('answer', 'once')">Allow once</button>
    </div>
  </div>
  <div v-else class="pending" role="group" aria-label="The AI asks" data-testid="ai-ask">
    <p class="q"><Icon name="sparkles" :size="15" /><span>{{ pending.input.question }}</span></p>
    <div class="options">
      <button v-for="o in pending.input.options" :key="o.label" class="option" data-testid="ai-ask-option" @click="emit('answer', { option: o.label })">
        <span>{{ o.label }}</span>
        <span v-if="o.description" class="desc">{{ o.description }}</span>
      </button>
    </div>
    <form v-if="pending.input.allowFreeText" class="free" @submit.prevent="sendFree">
      <input v-model="free" class="input" placeholder="Or type an answer" aria-label="Your answer" data-testid="ai-ask-text" />
      <button class="btn small primary" type="submit" :disabled="!free.trim()">Send</button>
    </form>
    <div class="actions">
      <button class="btn small ghost" @click="emit('answer', { dismissed: true })">Skip</button>
    </div>
  </div>
</template>

<style scoped>
.pending { display: flex; flex-direction: column; gap: 8px; padding: 10px 10px 8px; }
.q { display: flex; gap: 8px; align-items: flex-start; margin: 0; font-size: 14px; line-height: 1.45; color: var(--text-strong); }
.q > :first-child { flex: none; margin-top: 2px; color: var(--ai); }
.actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
.btn.small { min-height: 32px; padding: 0 12px; font-size: 13.5px; }
.options { display: flex; flex-direction: column; gap: 4px; }
.option {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 10px; text-align: left;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text-strong); font-size: 13.5px;
}
.option:hover { background: var(--surface-2); border-color: var(--border-strong); }
.desc { font-size: 12.5px; color: var(--muted); }
.free { display: flex; gap: 6px; }
.free .input { min-height: 32px; font-size: 13.5px; }
</style>
