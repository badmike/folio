<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { requireServices } from '../app'
import type { AccountInfo } from '../services/auth'
import { confirmDialog, promptDialog } from '../services/dialogs'
import { toast } from '../services/toast'
import { passkeysSupported } from '../services/webauthn'
import Icon from './Icon.vue'
import RecoveryCodes from './RecoveryCodes.vue'

const { auth, sync } = requireServices()
const user = auth.user
const accountsAvailable = computed(() => auth.available.value && sync.available)
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

const account = ref<AccountInfo | null>(null)
/** Codes generated in this panel, shown until it closes. */
const freshCodes = ref<string[] | null>(null)
const busy = ref(false)
const canPasskey = passkeysSupported()

async function refresh() {
  account.value = user.value && !auth.isDevToken ? (await auth.account()) ?? null : null
}
watch(user, () => { freshCodes.value = null; void refresh() }, { immediate: true })

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
function passkeyLine(p: { createdAt: number; lastUsedAt: number | null }): string {
  const added = `Added ${day.format(p.createdAt)}`
  return p.lastUsedAt ? `${added}, last used ${day.format(p.lastUsedAt)}` : added
}

async function run(fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  try { await fn() } finally { busy.value = false }
}

const signIn = () => run(() => auth.signIn())

const recover = () => run(async () => {
  const code = await promptDialog({ title: 'Sign in with a recovery code', label: 'Recovery code', confirmLabel: 'Sign in' })
  if (!code?.trim() || !(await auth.recover(code))) return
  toast('Signed in. Add a passkey so you don\'t need another code next time.', {
    actionLabel: 'Add passkey',
    action: () => void run(async () => { if (await auth.addPasskey()) await refresh() }),
  })
})

const addPasskey = () => run(async () => {
  if (await auth.addPasskey()) await refresh()
})

const removePasskey = (id: string) => run(async () => {
  const ok = await confirmDialog({
    title: 'Remove this passkey?',
    message: 'The device or security key that holds it can no longer sign in to folio.',
    confirmLabel: 'Remove',
    danger: true,
  })
  if (ok && await auth.deletePasskey(id)) await refresh()
})

const newCodes = () => run(async () => {
  const ok = await confirmDialog({
    title: 'Create new recovery codes?',
    message: 'Your current recovery codes stop working.',
    confirmLabel: 'Create codes',
  })
  if (!ok) return
  freshCodes.value = (await auth.newRecoveryCodes()) ?? null
  await refresh()
})
</script>

<template>
  <div class="account" data-testid="account-panel">
    <template v-if="user">
      <div class="setting">
        <span class="avatar ph"><Icon name="user" :size="20" /></span>
        <div class="text">
          <div class="name">{{ user.name }}</div>
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
      <template v-if="account">
        <div class="setting column">
          <div class="head">
            <div class="text"><div class="name">Passkeys</div></div>
            <button v-if="canPasskey" class="btn small" :disabled="busy" @click="addPasskey()"><Icon name="plus" :size="14" />Add passkey</button>
          </div>
          <ul class="passkeys">
            <li v-for="p in account.passkeys" :key="p.id">
              <span>{{ passkeyLine(p) }}</span>
              <button
                v-if="account.passkeys.length > 1" class="icon-btn small" aria-label="Remove passkey" :disabled="busy"
                @click="removePasskey(p.id)"
              ><Icon name="trash" :size="15" /></button>
            </li>
          </ul>
        </div>
        <div class="setting column">
          <div class="head">
            <div class="text">
              <div class="name">Recovery codes</div>
              <p :class="{ warn: account.recoveryCodesLeft < 3 }">{{ account.recoveryCodesLeft }} of 10 left</p>
            </div>
            <button class="btn small" :disabled="busy" @click="newCodes()">New codes</button>
          </div>
          <template v-if="freshCodes">
            <p class="hint">Save these now. folio shows them only once.</p>
            <RecoveryCodes :codes="freshCodes" />
          </template>
        </div>
      </template>
    </template>
    <div v-else class="setting signed-out">
      <span class="avatar ph"><Icon name="cloud" :size="20" /></span>
      <div class="text">
        <div class="name">Sync between devices</div>
        <p>folio works fully without an account. An account syncs your notebooks and turns on AI features. Accounts are by invite: ask whoever runs this folio server for a link.</p>
        <p v-if="!accountsAvailable"><strong>Accounts are not set up for this folio installation.</strong></p>
        <p v-else-if="!canPasskey"><strong>This browser can't use passkeys.</strong></p>
      </div>
      <div class="actions">
        <button class="btn primary small" :disabled="!accountsAvailable || !canPasskey || busy" data-testid="passkey-sign-in" @click="signIn()">Sign in with passkey</button>
        <button class="btn ghost small" :disabled="!accountsAvailable || busy" @click="recover()">Use a recovery code</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setting {
  display: flex; align-items: center; gap: 14px; padding: 12px 14px; margin-bottom: 8px; border-radius: var(--radius);
  background: color-mix(in srgb, var(--surface-2) 50%, var(--surface));
}
.text { flex: 1; min-width: 0; }
.name { font-size: 14px; font-weight: 600; color: var(--text-strong); }
.text p { margin: 3px 0 0; font-size: 13px; line-height: 1.45; color: var(--muted); overflow-wrap: anywhere; }
.text strong { color: var(--text); font-weight: 600; }
.avatar { flex: none; align-self: flex-start; width: 40px; height: 40px; border-radius: 50%; }
.ph { display: inline-flex; align-items: center; justify-content: center; background: var(--surface-2); color: var(--muted); }
.sync { display: flex; align-items: center; gap: 8px; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.dot.idle { background: var(--ok); }
.dot.syncing { background: var(--accent); }
.dot.offline, .dot.signed-out { background: var(--warn); }
.dot.error { background: var(--danger); }
.column { flex-direction: column; align-items: stretch; gap: 10px; }
.head { display: flex; align-items: center; gap: 14px; }
.passkeys { margin: 0; padding: 0; list-style: none; }
.passkeys li {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px;
  font-size: 14px; color: var(--text); border-top: 1px solid var(--border);
}
.icon-btn.small { width: 30px; height: 30px; color: var(--muted); }
.icon-btn.small:hover { color: var(--danger); }
.text p.warn { color: var(--warn); }
.hint { margin: 0; font-size: 13px; color: var(--muted); }
.actions { display: flex; flex-direction: column; align-items: stretch; gap: 4px; }
@media (max-width: 640px) {
  .signed-out { flex-wrap: wrap; }
  .signed-out .text { flex-basis: calc(100% - 54px); }
  .signed-out .actions { margin-left: 54px; }
}
</style>
