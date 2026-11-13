<script setup lang="ts">
import Icon from './Icon.vue'
import { toast } from '../services/toast'

const props = defineProps<{ codes: string[] }>()
const text = () => `folio recovery codes. Each one signs you in once.\n\n${props.codes.join('\n')}\n`

async function copy() {
  try {
    await navigator.clipboard.writeText(text())
    toast('Recovery codes copied', { kind: 'success' })
  } catch {
    toast('Could not copy. Select the codes and copy them by hand.')
  }
}

function download() {
  const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: 'folio-recovery-codes.txt' })
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="codes" data-testid="recovery-codes">
    <ol>
      <li v-for="c in codes" :key="c" class="mono">{{ c }}</li>
    </ol>
    <div class="actions">
      <button class="btn small" type="button" @click="copy()"><Icon name="copy" :size="14" />Copy</button>
      <button class="btn small" type="button" @click="download()"><Icon name="download" :size="14" />Download</button>
    </div>
  </div>
</template>

<style scoped>
.codes { padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
ol { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 16px; margin: 0; padding: 0; list-style: none; }
li { font-size: 15px; color: var(--text-strong); user-select: all; font-variant-numeric: tabular-nums; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
</style>
