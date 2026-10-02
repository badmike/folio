<script setup lang="ts">
import { computed } from 'vue'
import { requireServices } from '../app'
import Icon from './Icon.vue'

const { auth, sync } = requireServices()
const user = auth.user
const accountsAvailable = auth.configured && sync.available
const status = computed(() => sync.status.value)
const label = computed(() => {
  switch (sync.uiState.value) {
    case 'syncing': return 'Syncing…'
    case 'offline': return 'Offline — will sync when back online'
    case 'error': return `Sync problem${status.value.error ? `: ${status.value.error}` : ''}`
    case 'signed-out': return 'Session expired — sign in again'
    case 'idle': return status.value.pending ? `${status.value.pending} change(s) waiting` : 'All changes synced'
    default: return 'Sync is off'
  }
})
</script>

<template>
  <div class="account" data-testid="account-panel">
    <template v-if="user">
      <div class="setting">
        <img v-if="user.imageUrl" :src="user.imageUrl" alt="" class="avatar" />
        <span v-else class="avatar ph"><Icon name="user" :size="20" /></span>
        <div class="text">
          <div class="name">{{ user.name }}</div>
          <p>{{ user.email }}</p>
        </div>
        <button class="btn small" @click="auth.signOut()">Sign out</button>
      </div>
      <div class="setting">
        <div class="text">
          <div class="name">Sync</div>
          <p class="sync"><span class="dot" :class="sync.uiState.value" />{{ label }}</p>
        </div>
        <button class="btn small" @click="sync.syncNow()">Sync now</button>
      </div>
    </template>
    <div v-else class="setting signed-out">
      <span class="avatar ph"><Icon name="cloud" :size="20" /></span>
      <div class="text">
        <div class="name">Sync between devices</div>
        <p>folio works fully without an account. Create one to sync your notebooks and use AI features.</p>
        <p v-if="!accountsAvailable"><strong>Accounts are not set up for this folio installation.</strong></p>
      </div>
      <button class="btn primary small" :disabled="!accountsAvailable" @click="auth.signIn()">Create account</button>
    </div>
  </div>
</template>

<style scoped>
.setting { display: flex; align-items: center; gap: 14px; padding: 16px 0; border-bottom: 1px solid var(--border); }
.setting:last-child { border-bottom: 0; }
.text { flex: 1; min-width: 0; }
.name { font-size: 14px; font-weight: 600; color: var(--text-strong); }
.text p { margin: 3px 0 0; font-size: 13px; line-height: 1.45; color: var(--muted); overflow-wrap: anywhere; }
.text strong { color: var(--text); font-weight: 600; }
.avatar { flex: none; align-self: flex-start; width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
.ph { display: inline-flex; align-items: center; justify-content: center; background: var(--surface-2); color: var(--muted); }
.sync { display: flex; align-items: center; gap: 8px; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.dot.idle { background: var(--ok); }
.dot.syncing { background: var(--accent); }
.dot.offline, .dot.signed-out { background: var(--warn); }
.dot.error { background: var(--danger); }
@media (max-width: 640px) {
  .signed-out { flex-wrap: wrap; }
  .signed-out .text { flex-basis: calc(100% - 54px); }
  .signed-out .btn { margin-left: 54px; }
}
</style>
