<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { requireServices } from '../app'
import { passkeysSupported } from '../services/webauthn'
import Modal from './Modal.vue'
import RecoveryCodes from './RecoveryCodes.vue'

/** Turns an invite or admin reset link into a passkey, then shows the new recovery codes once. */
const { auth } = requireServices()
const link = auth.enrollment.value
const name = ref('')
const busy = ref(false)
const codes = ref<string[] | null>(null)
const input = ref<HTMLInputElement | null>(null)
const supported = passkeysSupported()
onMounted(() => input.value?.focus())

const title = computed(() => {
  if (codes.value) return 'Save your recovery codes'
  return link?.kind === 'reset' ? 'Set up a new passkey' : 'Create your folio account'
})
const description = computed(() => {
  if (codes.value) return 'Each code signs you in once if you lose your passkeys. folio shows them only now.'
  if (!supported) return 'This browser can\'t create passkeys. Open the link in a current version of Safari, Chrome, Edge or Firefox.'
  return link?.kind === 'reset'
    ? 'This replaces the passkeys and recovery codes of your account and signs out your other devices.'
    : 'Your account signs in with a passkey: Face ID, Touch ID, your device PIN or a security key.'
})

async function create() {
  if (busy.value) return
  busy.value = true
  codes.value = (await auth.enroll(name.value)) ?? null
  busy.value = false
}

const close = () => { auth.enrollment.value = null }
</script>

<template>
  <Modal :title="title" :description="description" @close="close()">
    <RecoveryCodes v-if="codes" :codes="codes" />
    <form v-else-if="supported" id="enroll-form" @submit.prevent="create()">
      <div v-if="link?.kind === 'invite'" class="field">
        <label for="enroll-name">Name</label>
        <input id="enroll-name" ref="input" v-model="name" class="input" maxlength="80" required autocomplete="name" data-testid="enroll-name" />
      </div>
    </form>
    <template #footer>
      <button v-if="codes" class="btn primary" type="button" @click="close()">Done</button>
      <template v-else>
        <button class="btn" type="button" @click="close()">Cancel</button>
        <button v-if="supported" class="btn primary" type="submit" form="enroll-form" :disabled="busy" data-testid="enroll-create">Create passkey</button>
      </template>
    </template>
  </Modal>
</template>
