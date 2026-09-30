<script setup lang="ts">
import { dismissToast, toasts } from '../services/toast'
import { recognitionPrompt } from '../services/prompt'
</script>

<template>
  <div class="toasts" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast panel floating" :class="t.kind" role="status">
      <span class="msg">{{ t.message }}</span>
      <button v-if="t.action" class="btn small primary" @click="t.action(); dismissToast(t.id)">{{ t.actionLabel }}</button>
      <button class="btn small ghost" aria-label="Dismiss" @click="dismissToast(t.id)">×</button>
    </div>
    <div v-if="recognitionPrompt" class="toast panel floating" role="status" data-testid="cleanup-prompt">
      <span class="msg">Clean up {{ recognitionPrompt.count }} item{{ recognitionPrompt.count === 1 ? '' : 's' }}?</span>
      <button class="btn small primary" data-testid="cleanup-apply" @click="recognitionPrompt.apply()">Apply</button>
      <button class="btn small ghost" aria-label="Dismiss" @click="recognitionPrompt.dismiss()">×</button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed; z-index: 1200; left: 50%; transform: translateX(-50%);
  bottom: calc(96px + var(--safe-bottom)); display: flex; flex-direction: column; gap: 8px; align-items: center;
  pointer-events: none; width: min(560px, calc(100% - 32px));
}
.toast { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 16px; pointer-events: auto; max-width: 100%; }
.toast.error { border-color: var(--danger); }
.toast.success { border-color: var(--ok); }
.msg { flex: 1; }
</style>
