<script setup lang="ts">
import { computed } from 'vue'
import { requireServices } from '../app'
import { exportDiagnostics } from '../services/diagnostics'
import { offlineReady } from '../services/pwa'
import { settings, toggleZen } from '../services/settings'
import AccountPanel from './AccountPanel.vue'
import Modal from './Modal.vue'

defineEmits<{ (e: 'close'): void }>()
const svc = requireServices()
const version = import.meta.env.VITE_FOLIO_VERSION || 'dev'

/** Only languages whose Tesseract data ships with the app work offline. */
const LANGS = [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }]

function toggleLang(code: string) {
  const has = settings.languages.includes(code)
  const next = has ? settings.languages.filter((l) => l !== code) : [...settings.languages, code]
  if (next.length) settings.languages = next
}

const cloudDisabledReason = computed(() => {
  if (!svc.sync.available) return 'Needs a folio server.'
  if (!svc.auth.signedIn.value) return 'Sign in to enable.'
  return ''
})
</script>

<template>
  <Modal title="Settings" wide @close="$emit('close')">
    <section>
      <h3>Account</h3>
      <AccountPanel />
    </section>

    <section>
      <h3>Handwriting</h3>
      <div class="field">
        <label>Clean up handwriting</label>
        <div class="seg" role="radiogroup">
          <button :class="{ on: settings.cleanupMode === 'keep' }" @click="settings.cleanupMode = 'keep'">Keep my ink</button>
          <button :class="{ on: settings.cleanupMode === 'ask' }" @click="settings.cleanupMode = 'ask'">Ask</button>
          <button :class="{ on: settings.cleanupMode === 'auto' }" @click="settings.cleanupMode = 'auto'">Automatic</button>
        </div>
        <span class="muted hint">Cleanup never deletes your ink; you can always restore it. Manual “Clean Up” is available on any selection.</span>
      </div>
      <div class="field">
        <label>Recognition languages</label>
        <div class="row">
          <button v-for="l in LANGS" :key="l.code" class="chip big" :class="{ on: settings.languages.includes(l.code) }" @click="toggleLang(l.code)">
            {{ l.label }}
          </button>
        </div>
      </div>
      <div class="field">
        <label class="check">
          <input type="checkbox" v-model="settings.cloudRefinement" :disabled="!!cloudDisabledReason" />
          Improve recognition in the cloud
          <span class="muted" v-if="cloudDisabledReason">({{ cloudDisabledReason }})</span>
        </label>
        <span class="muted hint">Sends a picture of your handwriting to the server for better machine-readable text. Your visible notes are never rewritten.</span>
      </div>
    </section>

    <section>
      <h3>Drawing</h3>
      <div class="field">
        <label>Shape style</label>
        <div class="seg">
          <button :class="{ on: settings.theme === 'rough' }" @click="settings.theme = 'rough'">Hand-drawn</button>
          <button :class="{ on: settings.theme === 'clean' }" @click="settings.theme = 'clean'">Clean</button>
        </div>
      </div>
      <div class="field">
        <label>Draw with</label>
        <div class="seg">
          <button :class="{ on: settings.penMode === 'auto' }" @click="settings.penMode = 'auto'">Pen + touch pans</button>
          <button :class="{ on: settings.penMode === 'pen-only' }" @click="settings.penMode = 'pen-only'">Pen only</button>
          <button :class="{ on: settings.penMode === 'any' }" @click="settings.penMode = 'any'">Any pointer</button>
        </div>
      </div>
      <div class="field">
        <label class="check">
          <input type="checkbox" v-model="settings.canvasFollowsTheme" data-testid="canvas-follows-theme" />
          Canvas: follow app theme
        </label>
        <span class="muted hint">New notebooks and pages get a dark or light paper colour matching the app’s light/dark appearance. Ink colours adapt automatically so dark pages stay legible.</span>
      </div>
      <div class="field">
        <label class="check">
          <input type="checkbox" :checked="settings.zen" data-testid="settings-zen" @change="toggleZen(($event.target as HTMLInputElement).checked)" />
          Zen mode
          <kbd>Alt</kbd>+<kbd>Z</kbd>
        </label>
        <span class="muted hint">A minimal interface: only a translucent tool strip while you draw.</span>
      </div>
      <div class="field">
        <label class="check">
          <input type="checkbox" v-model="settings.autoHideHud" data-testid="settings-autohide" />
          Hide the interface while drawing
        </label>
        <span class="muted hint">Menus, toolbar and zoom controls disappear while the pen is down and come back shortly after; only the compact colour bar stays.</span>
      </div>
      <div class="two">
        <div class="field">
          <label for="s-page">New notebooks</label>
          <select id="s-page" class="input" v-model="settings.defaultPageType">
            <option value="infinite">Infinite canvas</option>
            <option value="A4">A4 page</option>
            <option value="Letter">Letter page</option>
            <option value="iPad">iPad page</option>
          </select>
        </div>
        <div class="field">
          <label for="s-bg">Background</label>
          <select id="s-bg" class="input" v-model="settings.defaultPattern">
            <option value="blank">Blank</option>
            <option value="ruled">Ruled</option>
            <option value="grid">Grid</option>
            <option value="dot">Dots</option>
          </select>
        </div>
      </div>
    </section>

    <section>
      <h3>Data &amp; offline</h3>
      <p class="muted line">
        Stored on this device using <strong>{{ svc.storageKind === 'sqlite-opfs' ? 'SQLite (private file system)' : svc.storageKind === 'indexeddb' ? 'IndexedDB' : 'memory (not persistent!)' }}</strong>.
        <span v-if="offlineReady">Offline ready.</span><span v-else>Preparing offline use…</span>
      </p>
      <button class="btn" @click="exportDiagnostics({ storage: svc.storageKind })">Export diagnostics</button>
      <span class="muted hint"> Error messages only, never notebook content.</span>
      <p class="muted hint version">folio {{ version }}</p>
    </section>
  </Modal>
</template>

<style scoped>
section { margin-bottom: 22px; }
section:last-child { margin-bottom: 0; }
h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 10px; }
.hint { font-size: 12.5px; }
.chip.big { min-height: 38px; padding: 0 16px; font-size: 14px; border: 1px solid var(--border); }
.check { display: flex; align-items: center; gap: 10px; font-size: 15px; color: var(--text); }
.check input { width: 20px; height: 20px; accent-color: var(--accent); }
kbd { font: inherit; font-size: 12px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-2); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.line { margin: 0 0 10px; }
.version { margin: 12px 0 0; }
@media (max-width: 480px) { .two { grid-template-columns: 1fr; } }
</style>
