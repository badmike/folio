<script setup lang="ts">
import { computed } from 'vue'
import { bootError, bootState } from './app'
import DialogHost from './components/DialogHost.vue'
import Icon from './components/Icon.vue'
import ToastHost from './components/ToastHost.vue'
import { exportDiagnostics } from './services/diagnostics'

const isBooting = computed(() => bootState.value === 'booting')
const reload = () => window.location.reload()
</script>

<template>
  <div v-if="bootState === 'locked'" class="fullscreen" data-testid="locked">
    <Icon name="alert" :size="40" />
    <h1>folio is open in another tab</h1>
    <p class="muted">To keep your notebooks safe, folio can only run in one window at a time. Close the other tab or window, then reload this page.</p>
    <button class="btn primary" @click="reload()">Reload</button>
  </div>
  <div v-else-if="bootState === 'error'" class="fullscreen" data-testid="boot-error">
    <Icon name="alert" :size="40" />
    <h1>folio could not start</h1>
    <p class="muted">{{ bootError }}</p>
    <div class="row">
      <button class="btn primary" @click="reload()">Reload</button>
      <button class="btn" @click="exportDiagnostics()">Export diagnostics</button>
    </div>
  </div>
  <div v-else-if="isBooting" class="fullscreen" data-testid="booting">
    <Icon name="logo" :size="40" />
    <p class="muted">Opening folio…</p>
  </div>
  <template v-else>
    <router-view />
  </template>
  <DialogHost />
  <ToastHost />
</template>

<style scoped>
.fullscreen {
  position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 24px; text-align: center; background: var(--bg);
}
.fullscreen p { max-width: 420px; margin: 0; }
</style>
