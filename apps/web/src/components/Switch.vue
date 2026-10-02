<script setup lang="ts">
/** An on/off toggle. Use it for settings that apply immediately. */
const model = defineModel<boolean>({ required: true })
defineProps<{ disabled?: boolean; label: string }>()
</script>

<template>
  <button type="button" role="switch" class="switch" :aria-checked="model" :aria-label="label" :disabled="disabled" @click="model = !model">
    <span class="knob" />
  </button>
</template>

<style scoped>
.switch {
  flex: none; position: relative; width: 36px; height: 22px; padding: 0; border-radius: 11px;
  border: 1px solid var(--border-strong); background: var(--surface-3); transition: background 0.15s, border-color 0.15s;
}
.switch::before { content: ''; position: absolute; inset: -11px -6px; } /* touch target */
.switch[aria-checked='true'] { background: var(--accent); border-color: var(--accent); }
.switch:disabled { opacity: 0.45; cursor: not-allowed; }
.knob {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); transition: transform 0.15s;
}
.switch[aria-checked='true'] .knob { transform: translateX(14px); }
</style>
