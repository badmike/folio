<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { closeDialog, dialog } from '../services/dialogs'
import IconNameField, { type IconNameValue } from './IconNameField.vue'
import Modal from './Modal.vue'

const text = ref('')
const input = ref<HTMLInputElement | null>(null)
const look = ref<IconNameValue>({ name: '', icon: null, color: null })
const lookField = ref<InstanceType<typeof IconNameField> | null>(null)

watch(dialog, async (d) => {
  if (d?.kind === 'prompt') {
    text.value = d.value
    await nextTick()
    input.value?.focus()
    input.value?.select()
  } else if (d?.kind === 'appearance') {
    look.value = { ...d.value }
    await nextTick()
    lookField.value?.focus()
  }
})

function answer(v: boolean | string | IconNameValue | null) {
  const d = dialog.value
  if (!d) return
  if (d.kind === 'confirm') d.resolve(v === true)
  else if (d.kind === 'appearance') d.resolve(typeof v === 'object' ? v : null)
  else d.resolve(typeof v === 'string' ? v : null)
  closeDialog()
}
</script>

<template>
  <Modal v-if="dialog" :title="dialog.title" @close="answer(dialog.kind === 'confirm' ? false : null)">
    <template v-if="dialog.kind === 'confirm'">
      <p class="msg">{{ dialog.message }}</p>
    </template>
    <form v-else-if="dialog.kind === 'prompt'" id="dlg-form" @submit.prevent="answer(text)">
      <div class="field">
        <label v-if="dialog.label" for="dlg-input">{{ dialog.label }}</label>
        <input id="dlg-input" ref="input" v-model="text" class="input" autocomplete="off" />
      </div>
    </form>
    <form v-else-if="dialog.kind === 'appearance'" id="dlg-form" @submit.prevent="answer(look)">
      <IconNameField ref="lookField" v-model="look" :label="dialog.label" />
    </form>
    <div v-else class="choices">
      <button v-for="o in dialog.options" :key="o.value" class="btn ghost choice" :style="{ paddingLeft: 16 + (o.depth ?? 0) * 18 + 'px' }" @click="answer(o.value)">
        {{ o.label }}
      </button>
    </div>
    <template #footer>
      <template v-if="dialog.kind === 'confirm'">
        <button class="btn" @click="answer(false)">Cancel</button>
        <button class="btn primary" :class="{ danger: dialog.danger }" @click="answer(true)">{{ dialog.confirmLabel }}</button>
      </template>
      <template v-else-if="dialog.kind === 'prompt' || dialog.kind === 'appearance'">
        <button class="btn" type="button" @click="answer(null)">Cancel</button>
        <button class="btn primary" type="submit" form="dlg-form">{{ dialog.confirmLabel }}</button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.msg { margin: 0; white-space: pre-wrap; }
.choices { display: flex; flex-direction: column; margin: -8px -12px; }
.choice { justify-content: flex-start; }
</style>
