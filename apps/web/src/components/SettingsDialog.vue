<script setup lang="ts">
import { computed, ref } from 'vue'
import { requireServices } from '../app'
import { confirmDialog } from '../services/dialogs'
import { exportDiagnostics } from '../services/diagnostics'
import { handwriting, resetHandwriting } from '../services/handwriting'
import { offlineReady, refreshApp } from '../services/pwa'
import { settings, toggleZen } from '../services/settings'
import AccountPanel from './AccountPanel.vue'
import CalibrationDialog from './CalibrationDialog.vue'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import Switch from './Switch.vue'

defineEmits<{ (e: 'close'): void }>()
const svc = requireServices()
const version = import.meta.env.VITE_FOLIO_VERSION || 'dev'

const SECTIONS = [
  { id: 'account', label: 'Account', icon: 'user' },
  { id: 'handwriting', label: 'Handwriting', icon: 'pen' },
  { id: 'drawing', label: 'Drawing', icon: 'shape' },
  { id: 'data', label: 'Data & offline', icon: 'layers' },
] as const
type Section = (typeof SECTIONS)[number]['id']
const section = ref<Section>('account')
const current = computed(() => SECTIONS.find((s) => s.id === section.value)!)

/** Only languages whose Tesseract data ships with the app work offline. */
const LANGS = [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }]

function toggleLang(code: string) {
  const has = settings.languages.includes(code)
  const next = has ? settings.languages.filter((l) => l !== code) : [...settings.languages, code]
  if (next.length) settings.languages = next
}

const calibrating = ref(false)
const pct = (x: number) => Math.round(x * 100)
const learned = computed(() => ({ words: Object.keys(handwriting.value.words).length, fixes: Object.keys(handwriting.value.fixes).length }))
const calibration = computed(() => {
  const c = handwriting.value.calibration
  return c && `Calibrated on ${new Date(c.at).toLocaleDateString()}: ${pct(c.before)}% wrong characters before, ${pct(c.after)}% after.`
})

async function forgetHandwriting() {
  const ok = await confirmDialog({
    title: 'Forget your handwriting?',
    message: 'folio forgets the calibration, your words and the corrections it learned on this device.',
    confirmLabel: 'Forget',
    danger: true,
  })
  if (ok) resetHandwriting()
}

const zen = computed({ get: () => settings.zen, set: (v: boolean) => toggleZen(v) })

const cloudDisabledReason = computed(() => {
  if (!svc.sync.available) return 'Needs a folio server.'
  if (!svc.auth.signedIn.value) return 'Sign in to enable.'
  return ''
})

const refreshing = ref(false)
async function refresh() {
  refreshing.value = true
  await svc.workspace.flushAll()
  await refreshApp()
}

const STORAGE: Record<typeof svc.storageKind, string> = { 'sqlite-opfs': 'SQLite', indexeddb: 'IndexedDB', memory: 'Memory only' }
</script>

<template>
  <CalibrationDialog v-if="calibrating" @close="calibrating = false" />
  <Modal v-else title="Settings" bare @close="$emit('close')">
    <div class="settings">
      <nav class="nav" aria-label="Settings sections">
        <div class="intro">
          <h2>Settings</h2>
          <p class="muted">Applies to folio on this device.</p>
        </div>
        <button v-for="s in SECTIONS" :key="s.id" class="tab" :class="{ on: section === s.id }"
          :aria-current="section === s.id ? 'page' : undefined" @click="section = s.id">
          <Icon :name="s.icon" :size="16" /> {{ s.label }}
        </button>
        <span class="spacer" />
        <p class="version muted">folio {{ version }}</p>
      </nav>

      <div class="pane">
        <header>
          <h3>{{ current.label }}</h3>
          <button class="icon-btn" aria-label="Close" @click="$emit('close')"><Icon name="x" :size="18" /></button>
        </header>

        <div class="rows">
          <template v-if="section === 'account'">
            <AccountPanel />
          </template>

          <template v-else-if="section === 'handwriting'">
            <div class="setting">
              <div class="text">
                <div class="name">Clean up handwriting</div>
                <p>Turn ink into text and shapes. Cleanup never deletes your ink, you can always restore it.</p>
              </div>
              <div class="seg soft" role="radiogroup" aria-label="Clean up handwriting">
                <button :class="{ on: settings.cleanupMode === 'keep' }" @click="settings.cleanupMode = 'keep'">Keep my ink</button>
                <button :class="{ on: settings.cleanupMode === 'ask' }" @click="settings.cleanupMode = 'ask'">Ask</button>
                <button :class="{ on: settings.cleanupMode === 'auto' }" @click="settings.cleanupMode = 'auto'">Automatic</button>
              </div>
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Recognition languages</div>
                <p>Languages your handwriting is read in. Both work offline.</p>
              </div>
              <div class="seg soft" aria-label="Recognition languages">
                <button v-for="l in LANGS" :key="l.code" :class="{ on: settings.languages.includes(l.code) }"
                  :aria-pressed="settings.languages.includes(l.code)" @click="toggleLang(l.code)">{{ l.label }}</button>
              </div>
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Your handwriting</div>
                <p>{{ calibration ?? 'Write three short sentences so folio can tune recognition to your handwriting.' }}
                  Editing text from Clean Up teaches folio the words it misread<template v-if="learned.words || learned.fixes">,
                  so far {{ learned.words }} words and {{ learned.fixes }} corrections</template>.</p>
              </div>
              <div class="pair">
                <button v-if="calibration || learned.words" class="btn small ghost" data-testid="forget-handwriting" @click="forgetHandwriting">Forget</button>
                <button class="btn small" data-testid="calibrate" @click="calibrating = true">{{ calibration ? 'Calibrate again' : 'Calibrate' }}</button>
              </div>
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Improve recognition in the cloud</div>
                <p>Sends a picture of your handwriting to the server for better searchable text. Your notes are never rewritten.
                  <strong v-if="cloudDisabledReason">{{ cloudDisabledReason }}</strong></p>
              </div>
              <Switch v-model="settings.cloudRefinement" label="Improve recognition in the cloud" :disabled="!!cloudDisabledReason" />
            </div>
          </template>

          <template v-else-if="section === 'drawing'">
            <div class="setting">
              <div class="text">
                <div class="name">Shape style</div>
                <p>How shapes, arrows and cleaned-up drawings look.</p>
              </div>
              <div class="seg soft" role="radiogroup" aria-label="Shape style">
                <button :class="{ on: settings.theme === 'rough' }" @click="settings.theme = 'rough'">Hand-drawn</button>
                <button :class="{ on: settings.theme === 'clean' }" @click="settings.theme = 'clean'">Clean</button>
              </div>
            </div>
            <div class="setting">
              <div class="text">
                <label class="name" for="s-pen">Draw with</label>
                <p>Which input draws. With "Pen + touch pans", fingers move the canvas.</p>
              </div>
              <select id="s-pen" class="input" v-model="settings.penMode">
                <option value="auto">Pen + touch pans</option>
                <option value="pen-only">Pen only</option>
                <option value="any">Any pointer</option>
              </select>
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Selection</div>
                <p>What dragging a selection box or lasso picks up.</p>
              </div>
              <div class="seg soft" role="radiogroup" aria-label="Selection">
                <button :class="{ on: settings.selectionMode === 'overlap' }" @click="settings.selectionMode = 'overlap'">Touching</button>
                <button :class="{ on: settings.selectionMode === 'wrap' }" @click="settings.selectionMode = 'wrap'">Fully inside</button>
              </div>
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Snap to objects</div>
                <p>Moving, resizing and drawing shapes snaps to the edges and centres of nearby objects. Hold <kbd>⌘</kbd> or <kbd>Ctrl</kbd> to place freely.</p>
              </div>
              <Switch v-model="settings.snapToObjects" label="Snap to objects" data-testid="settings-snap-objects" />
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Snap to grid</div>
                <p>Snaps to the page pattern, or a 20 point grid on blank pages.</p>
              </div>
              <Switch v-model="settings.snapToGrid" label="Snap to grid" data-testid="settings-snap-grid" />
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Scribble to erase</div>
                <p>Scribble back and forth over ink with the pen to erase it.</p>
              </div>
              <Switch v-model="settings.scribbleErase" label="Scribble to erase" data-testid="settings-scribble-erase" />
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Canvas follows app theme</div>
                <p>New pages get dark or light paper to match the app. Ink colours adapt so dark pages stay legible.</p>
              </div>
              <Switch v-model="settings.canvasFollowsTheme" label="Canvas follows app theme" data-testid="canvas-follows-theme" />
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Zen mode <kbd>Alt</kbd> <kbd>Z</kbd></div>
                <p>A minimal interface: only a translucent tool strip while you draw.</p>
              </div>
              <Switch v-model="zen" label="Zen mode" data-testid="settings-zen" />
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Hide the interface while drawing</div>
                <p>Menus, toolbar and zoom controls step aside while the pen is down. The colour bar stays.</p>
              </div>
              <Switch v-model="settings.autoHideHud" label="Hide the interface while drawing" data-testid="settings-autohide" />
            </div>
            <div class="setting">
              <div class="text">
                <label class="name" for="s-page">New notebooks</label>
                <p>Page type and background for notebooks you create.</p>
              </div>
              <div class="pair">
                <select id="s-page" class="input" v-model="settings.defaultPageType">
                  <option value="infinite">Infinite canvas</option>
                  <option value="A4">A4 page</option>
                  <option value="Letter">Letter page</option>
                  <option value="iPad">iPad page</option>
                </select>
                <select class="input" aria-label="Background" v-model="settings.defaultPattern">
                  <option value="blank">Blank</option>
                  <option value="ruled">Ruled</option>
                  <option value="grid">Grid</option>
                  <option value="dot">Dots</option>
                  <option value="music">Music</option>
                  <option value="isometric">Isometric</option>
                  <option value="hex">Hexagon</option>
                  <option value="cornell">Cornell</option>
                  <option value="handwriting">Handwriting</option>
                  <option value="engineering">Engineering</option>
                  <option value="isodot">Iso dots</option>
                  <option value="tablature">Tablature</option>
                  <option value="polar">Polar</option>
                </select>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="setting">
              <div class="text">
                <div class="name">Storage</div>
                <p>Notebooks are stored on this device<template v-if="svc.storageKind === 'sqlite-opfs'"> in the browser's private file system</template>.
                  <strong v-if="svc.storageKind === 'memory'">They are lost when you close folio.</strong></p>
              </div>
              <span class="value">{{ STORAGE[svc.storageKind] }}</span>
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Offline use</div>
                <p>folio caches itself so it opens and works without a connection.</p>
              </div>
              <span class="value" :class="{ ok: offlineReady }">
                <Icon v-if="offlineReady" name="check" :size="14" />{{ offlineReady ? 'Ready' : 'Preparing…' }}
              </span>
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Updates</div>
                <p>Running folio {{ version }}. Reload to get the latest version. Your notebooks are saved first.</p>
              </div>
              <button class="btn small" :disabled="refreshing" data-testid="refresh-app" @click="refresh">
                {{ refreshing ? 'Reloading…' : 'Reload' }}
              </button>
            </div>
            <div class="setting">
              <div class="text">
                <div class="name">Diagnostics</div>
                <p>A file with recent error messages for bug reports. Never contains notebook content.</p>
              </div>
              <button class="btn small" @click="exportDiagnostics({ storage: svc.storageKind })">Export</button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.settings { flex: 1; min-height: 0; display: flex; }

.nav {
  width: 220px; flex: none; display: flex; flex-direction: column; gap: 2px;
  padding: 22px 12px 14px; background: var(--sidebar);
}
.intro { padding: 0 8px 16px; }
.intro h2 { font-size: 20px; font-weight: 650; color: var(--text-strong); letter-spacing: -0.01em; }
.intro p { margin: 2px 0 0; font-size: 13px; }
.tab {
  display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 0 10px; border: 0; border-radius: var(--radius);
  background: transparent; color: var(--text); font-size: 14px; text-align: left;
}
.tab:hover { background: var(--surface-2); }
.tab.on { background: var(--surface-3); color: var(--text-strong); font-weight: 600; }
.tab :deep(svg) { color: var(--muted); }
.tab.on :deep(svg) { color: var(--accent); }
.version { margin: 0; padding: 0 10px; font-size: 12px; }

.pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pane header {
  display: flex; align-items: center; justify-content: space-between;
  margin: 0 14px 0 24px; padding: 18px 0 12px;
}
.pane header .icon-btn { width: 30px; height: 30px; color: var(--muted); }
.pane header .icon-btn:hover { color: var(--text-strong); }
.pane h3 { font-size: 16px; font-weight: 650; color: var(--text-strong); }
.rows { flex: 1; overflow: auto; padding: 0 24px 24px; display: flex; flex-direction: column; gap: 8px; }

.setting { display: flex; align-items: center; gap: 24px; padding: 12px 14px; border-radius: var(--radius); background: color-mix(in srgb, var(--surface-2) 50%, var(--surface)); }
.text { flex: 1; min-width: 0; }
.name { display: flex; align-items: center; gap: 4px; font-size: 14px; font-weight: 600; color: var(--text-strong); }
.text p { margin: 3px 0 0; font-size: 13px; line-height: 1.45; color: var(--muted); }
.text strong { color: var(--text); font-weight: 600; }
.value { display: inline-flex; align-items: center; gap: 4px; font-size: 13.5px; color: var(--text); }
.value.ok { color: var(--ok); }
kbd { font-size: 11px; font-weight: 500; }

.input { width: auto; min-width: 160px; min-height: 34px; font-size: 14px; }
.pair { display: flex; gap: 8px; }
.pair .input { min-width: 0; }

.seg { flex: none; }

@media (pointer: coarse) {
  .tab, .input { min-height: 40px; }
}

@media (max-width: 640px) {
  .settings { flex-direction: column; }
  .nav { width: auto; flex-direction: row; gap: 4px; overflow-x: auto; padding: 10px; }
  .intro, .version, .nav .spacer { display: none; }
  .tab { flex: none; }
  .pane header { margin: 0 6px 0 16px; padding: 6px 0; }
  .rows { padding: 0 16px 20px; }
  .setting { flex-wrap: wrap; gap: 10px; }
  .text { flex-basis: 100%; }
}
</style>
