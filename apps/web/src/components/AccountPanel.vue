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
      <div class="row who">
        <img v-if="user.imageUrl" :src="user.imageUrl" alt="" class="avatar" />
        <span v-else class="avatar ph"><Icon name="user" /></span>
        <div class="spacer">
          <strong>{{ user.name }}</strong>
          <div class="muted small">{{ user.email }}</div>
        </div>
        <button class="btn small" @click="auth.signOut()">Sign out</button>
      </div>
      <div class="row sync"><span class="dot" :class="sync.uiState.value" />{{ label }}
        <span class="spacer" /><button class="btn small ghost" @click="sync.syncNow()">Sync now</button></div>
    </template>
    <template v-else>
      <p class="muted">folio works fully without an account. Create an account to sync your notebooks between devices and use AI features.</p>
      <button class="btn primary" :disabled="!accountsAvailable" @click="auth.signIn()">
        <Icon name="user" :size="18" /> Create account to sync
      </button>
      <p v-if="!accountsAvailable" class="muted small">Accounts are not set up for this folio installation.</p>
    </template>
  </div>
</template>

<style scoped>
.account p { margin: 0 0 10px; }
.who { margin-bottom: 8px; }
.avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--surface-3); display: inline-flex; align-items: center; justify-content: center; }
.small { font-size: 12.5px; }
.sync { font-size: 14px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); display: inline-block; }
.dot.idle { background: var(--ok); }
.dot.syncing { background: var(--accent); }
.dot.offline, .dot.signed-out { background: var(--warn); }
.dot.error { background: var(--danger); }
</style>
