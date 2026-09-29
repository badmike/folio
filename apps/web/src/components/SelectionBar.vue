<script setup lang="ts">
import { computed, inject } from 'vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import { copyText } from '../services/export'
import { toast, toastError } from '../services/toast'
import { diagnostics } from '../services/diagnostics'
import { ref } from 'vue'
import Icon from './Icon.vue'

defineProps<{ placement: 'top' | 'bottom' }>()
const ctl = inject<NotebookController>(NOTEBOOK_KEY)!
const sel = ctl.selection
const busy = ref(false)
const show = computed(() => sel.value.count > 0 && !ctl.editingText.value)

async function cleanUp() {
  const rec = ctl.recognitionApi
  if (!rec || busy.value) return
  busy.value = true
  try {
    const n = await rec.cleanUpSelection()
    if (n === 0) toast('Nothing to clean up here — the ink was not recognized with enough confidence.')
  } catch (e) {
    diagnostics.log('cleanup', e)
    toastError('Clean Up failed.')
  } finally { busy.value = false }
}
async function copy() {
  const text = ctl.recognitionApi?.selectionText() ?? ''
  if (!text) return toast('No recognized text in the selection yet.')
  toast((await copyText(text)) ? 'Text copied' : 'Could not copy', { kind: 'success' })
}
const e = () => ctl.editor.value!
</script>

<template>
  <div v-if="show" class="sel panel" :class="placement" role="toolbar" aria-label="Selection actions" data-testid="selection-bar" @pointerdown.stop>
    <button v-if="sel.ink" class="btn small ghost" data-testid="cleanup" :disabled="busy" @click="cleanUp"><Icon name="cleanup" :size="18" /> {{ busy ? 'Working…' : 'Clean Up' }}</button>
    <button v-if="sel.derived" class="btn small ghost" data-testid="restore-ink" @click="ctl.recognitionApi?.restoreSelection()"><Icon name="restore" :size="18" /> Restore ink</button>
    <button class="icon-btn" aria-label="Duplicate" title="Duplicate" @click="e().duplicateSelection()"><Icon name="copy" :size="20" /></button>
    <button v-if="sel.count > 1" class="icon-btn" aria-label="Group" title="Group" @click="e().groupSelection()"><Icon name="group" :size="20" /></button>
    <button v-if="sel.group" class="icon-btn" aria-label="Ungroup" title="Ungroup" @click="e().ungroupSelection()"><Icon name="ungroup" :size="20" /></button>
    <button v-if="sel.text" class="icon-btn" aria-label="Copy recognized text" title="Copy text" @click="copy"><Icon name="doc" :size="20" /></button>
    <button class="icon-btn" aria-label="Bring to front" title="Bring to front" @click="e().bringToFront()"><Icon name="front" :size="20" /></button>
    <button class="icon-btn" aria-label="Send to back" title="Send to back" @click="e().sendToBack()"><Icon name="back_" :size="20" /></button>
    <button class="icon-btn danger" aria-label="Delete" title="Delete" data-testid="delete-selection" @click="e().deleteSelection()"><Icon name="trash" :size="20" /></button>
  </div>
</template>

<style scoped>
.sel { position: absolute; left: 50%; transform: translateX(-50%); z-index: 19; display: flex; align-items: center; gap: 2px; padding: 4px 6px; max-width: calc(100% - 16px); overflow-x: auto; scrollbar-width: none; }
.sel.bottom { bottom: calc(76px + var(--safe-bottom)); }
.sel.top { top: calc(126px + var(--safe-top)); }
</style>
