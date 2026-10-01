<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { whenReady } from '../app'
import Icon from '../components/Icon.vue'
import Logo from '../components/Logo.vue'
import { NotebookController } from '../notebook'
import { NotebookNotFoundError } from '../services/workspace'
import { diagnostics } from '../services/diagnostics'
import NotebookScreen from './NotebookScreen.vue'

const props = defineProps<{ id: string }>()
const router = useRouter()
const state = ref<'loading' | 'syncing' | 'ready' | 'missing' | 'error'>('loading')
const ctl = shallowRef<NotebookController | null>(null)
let token = 0
let stopWaiting: (() => void) | null = null

/** `retry` re-checks a notebook that is listed in the library but whose content has not synced yet. */
async function load(id: string, retry = false) {
  const my = ++token
  stopWaiting?.()
  stopWaiting = null
  if (!retry) {
    state.value = 'loading'
    ctl.value = null
  }
  try {
    const svc = await whenReady()
    const session = await svc.workspace.openNotebook(id)
    if (my !== token) { await svc.workspace.release(id); return }
    ctl.value = new NotebookController(svc.workspace, session, svc.recognition)
    state.value = 'ready'
  } catch (e) {
    if (my !== token) return
    if (!(e instanceof NotebookNotFoundError)) {
      diagnostics.log('openNotebook', e)
      state.value = 'error'
      return
    }
    const { workspace } = await whenReady()
    if (my !== token) return
    if (workspace.entry(id)) {
      state.value = 'syncing'
      stopWaiting = workspace.onChange(() => void load(id, true))
    } else {
      state.value = 'missing'
    }
  }
}
watch(() => props.id, (id) => load(id), { immediate: true })
onBeforeUnmount(() => {
  token++
  stopWaiting?.()
})
</script>

<template>
  <NotebookScreen v-if="state === 'ready' && ctl" :key="ctl.id" :ctl="ctl" />
  <div v-else class="msg">
    <template v-if="state === 'loading' || state === 'syncing'">
      <Logo class="mark" :height="64" />
      <p class="muted">{{ state === 'syncing' ? 'Waiting for this notebook to sync…' : 'Opening notebook…' }}</p>
      <button v-if="state === 'syncing'" class="btn" @click="router.push('/')">Back to library</button>
    </template>
    <template v-else>
      <Icon name="alert" :size="36" />
      <h2>{{ state === 'missing' ? 'Notebook not found' : 'Could not open this notebook' }}</h2>
      <p class="muted">{{ state === 'missing' ? 'It may have been deleted.' : 'Your data is untouched. Try again or export diagnostics from Settings.' }}</p>
      <button class="btn primary" @click="router.push('/')">Back to library</button>
    </template>
  </div>
</template>

<style scoped>
.msg { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 24px; }
.msg p { margin: 0; max-width: 380px; }
.mark { color: var(--text-strong); }
</style>
