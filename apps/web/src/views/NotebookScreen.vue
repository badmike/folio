<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { requireServices } from '../app'
import AiPanel from '../components/AiPanel.vue'
import Icon from '../components/Icon.vue'
import Menu, { type MenuItem } from '../components/Menu.vue'
import NotebookSearch from '../components/NotebookSearch.vue'
import PagePanel from '../components/PagePanel.vue'
import PropertiesPanel from '../components/PropertiesPanel.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import Toolbar from '../components/Toolbar.vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import { diagnostics } from '../services/diagnostics'
import { exportFolioFile, exportMarkdownFile, exportPdf, exportPng } from '../services/export'
import { settings, toggleZen } from '../services/settings'
import { toastError } from '../services/toast'

const props = defineProps<{ ctl: NotebookController }>()
const ctl = props.ctl
provide(NOTEBOOK_KEY, ctl)

const router = useRouter()
const route = useRoute()
const { workspace: ws, sync, auth } = requireServices()
const host = ref<HTMLElement | null>(null)
const panel = ref<'pages' | 'search' | 'ai' | null>(null)
const zen = computed(() => settings.zen)
/** Zen tool strip fades to low opacity 2 s after drawing starts; hover/tap near it brings it back. */
const faded = ref(false)
let fadeTimer: ReturnType<typeof setTimeout> | undefined
function armFade() {
  clearTimeout(fadeTimer)
  if (!settings.zen) return
  fadeTimer = setTimeout(() => { faded.value = true }, 2000)
}
function wake() { clearTimeout(fadeTimer); faded.value = false }
function onHostPointerDown() {
  if (ctl.highlighted.value) ctl.clearHighlight()
  armFade()
}
watch(zen, (on) => {
  wake()
  if (on) { panel.value = null; showSettings.value = false; ctl.showToolOptions.value = false }
})
function onKeyDown(e: KeyboardEvent) {
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyZ') { e.preventDefault(); toggleZen() }
}
const showSettings = ref(false)
const editingTitle = ref(false)
const titleDraft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

// Toolbar goes to the bottom on touch devices / narrow screens, top-centre otherwise.
const narrow = ref(false)
function measureLayout() {
  narrow.value = (window.matchMedia?.('(pointer: coarse)').matches ?? false) || window.innerWidth < 720
}
const placement = computed<'top' | 'bottom'>(() => (narrow.value ? 'bottom' : 'top'))

function togglePanel(p: 'pages' | 'search' | 'ai') {
  panel.value = panel.value === p ? null : p
}

// ---- title ---------------------------------------------------------------------
async function startTitleEdit() {
  titleDraft.value = ctl.title.value
  editingTitle.value = true
  await nextTick()
  titleInput.value?.focus()
  titleInput.value?.select()
}
async function commitTitle() {
  if (!editingTitle.value) return
  editingTitle.value = false
  const t = titleDraft.value.trim()
  if (t && t !== ctl.title.value) {
    ctl.title.value = t
    await ws.renameNotebook(ctl.id, t)
  }
}

// ---- navigation ------------------------------------------------------------------
async function back() {
  await router.push('/')
}

function applyRouteFocus() {
  const page = typeof route.query.page === 'string' ? route.query.page : null
  const obj = typeof route.query.obj === 'string' ? route.query.obj : null
  if (!page && !obj) return
  ctl.focus(page, obj)
}

const onPageHide = () => ctl.flushPending()
onMounted(async () => {
  measureLayout()
  window.addEventListener('resize', measureLayout)
  window.addEventListener('pagehide', onPageHide, true)
  window.addEventListener('keydown', onKeyDown)
  await nextTick()
  const page = typeof route.query.page === 'string' ? route.query.page : undefined
  ctl.mount(host.value!, page)
  applyRouteFocus()
})
watch(() => [route.query.page, route.query.obj], applyRouteFocus)
watch(() => settings.theme, (t) => ctl.editor.value?.setTheme(t))
watch(() => settings.penMode, (m) => ctl.editor.value?.setPenMode(m))
onBeforeUnmount(() => {
  window.removeEventListener('resize', measureLayout)
  window.removeEventListener('pagehide', onPageHide, true)
  window.removeEventListener('keydown', onKeyDown)
  clearTimeout(fadeTimer)
  void ctl.destroy().catch((e) => diagnostics.log('notebook.destroy', e))
})

// ---- export ---------------------------------------------------------------------
async function run(fn: () => Promise<unknown>) {
  try { ctl.flushPending(); await fn() } catch (e) { diagnostics.log('export', e); toastError('Export failed.') }
}
const mainItems = computed<MenuItem[]>(() => [
  { label: 'Zen mode', icon: 'zen', checked: settings.zen, action: () => toggleZen() },
  { divider: true },
  { label: 'Export as Markdown (.md)', icon: 'doc', action: () => void run(async () => exportMarkdownFile(ctl.title.value, await ws.exportMarkdownText(ctl.id))) },
  { label: 'Export page as image (.png)', icon: 'download', action: () => void run(() => exportPng(ctl.doc, ctl.pageId.value, settings.theme, ctl.editor.value)) },
  { label: 'Export as PDF', icon: 'download', action: () => void run(() => exportPdf(ctl.doc, settings.theme)) },
  { label: 'Export as folio file (.folio)', icon: 'download', action: () => void run(() => exportFolioFile(ws, ctl.id, ctl.title.value)) },
  { divider: true },
  { label: 'Settings', icon: 'settings', action: () => { showSettings.value = true } },
])

const syncClass = computed(() => sync.uiState.value)
const syncTitle = computed(() => {
  switch (sync.uiState.value) {
    case 'local': return auth.signedIn.value ? 'Not syncing' : 'Saved on this device'
    case 'idle': return 'Synced'
    case 'syncing': return 'Syncing…'
    case 'offline': return 'Offline — changes are saved locally'
    case 'error': return 'Sync problem'
    default: return 'Sign in to sync'
  }
})
const zoomPct = computed(() => Math.round(ctl.zoom.value * 100))
</script>

<template>
  <div class="screen" data-testid="notebook-screen">
    <div ref="host" class="canvas-host" data-testid="editor-host" @pointerdown.capture="onHostPointerDown" />

    <header v-if="!zen" class="topbar">
      <button class="icon-btn panel" aria-label="Back to library" data-testid="back" @click="back"><Icon name="back" /></button>
      <div class="title panel">
        <input v-if="editingTitle" ref="titleInput" v-model="titleDraft" class="title-input" aria-label="Notebook title" data-testid="title-input"
               @keydown.enter.prevent="commitTitle" @keydown.esc.prevent="editingTitle = false" @blur="commitTitle" />
        <button v-else class="title-btn" data-testid="title" title="Rename" @click="startTitleEdit">{{ ctl.title.value || 'Untitled' }}</button>
        <span class="dot" :class="syncClass" :title="syncTitle" data-testid="sync-dot" />
      </div>
      <span class="spacer" />
      <div class="actions panel">
        <button class="icon-btn" :class="{ active: panel === 'search' }" aria-label="Search in notebook" data-testid="open-search" @click="togglePanel('search')"><Icon name="search" /></button>
        <button class="icon-btn" :class="{ active: panel === 'pages' }" aria-label="Pages and background" data-testid="open-pages" @click="togglePanel('pages')"><Icon name="layers" /></button>
        <button class="icon-btn" :class="{ active: panel === 'ai' }" aria-label="AI assistant" data-testid="open-ai" @click="togglePanel('ai')"><Icon name="sparkles" /></button>
        <Menu :items="mainItems" align="right">
          <button class="icon-btn" aria-label="Main menu" data-testid="main-menu"><Icon name="menu" /></button>
        </Menu>
      </div>
    </header>

    <Toolbar :placement="placement" :zen="zen" :faded="zen && faded" @wake="wake" />
    <PropertiesPanel :placement="placement" :zen="zen" />
    <button v-if="zen" class="zen-exit panel" data-testid="zen-exit" @click="toggleZen(false)">Exit zen mode</button>

    <div v-if="!zen" class="zoom panel" :class="placement">
      <button class="icon-btn small" aria-label="Fit to content" title="Fit" data-testid="zoom-fit" @click="ctl.fit()"><Icon name="fit" :size="18" /></button>
      <button class="zoom-pct" aria-label="Reset zoom to 100%" data-testid="zoom-pct" @click="ctl.resetZoom()">{{ zoomPct }}%</button>
    </div>

    <template v-if="!zen">
      <PagePanel v-if="panel === 'pages'" @close="panel = null" />
      <NotebookSearch v-else-if="panel === 'search'" @close="panel = null" />
      <AiPanel v-else-if="panel === 'ai'" @close="panel = null" />
    </template>
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.screen { position: fixed; inset: 0; overflow: hidden; background: var(--bg); }
.canvas-host { position: absolute; inset: 0; touch-action: none; }
.topbar {
  position: absolute; z-index: 25; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 8px; pointer-events: none;
  padding: calc(8px + var(--safe-top)) calc(8px + var(--safe-right)) 0 calc(8px + var(--safe-left));
}
.topbar > * { pointer-events: auto; }
.topbar > .spacer { pointer-events: none; }
.title { display: flex; align-items: center; gap: 8px; padding: 0 14px 0 4px; min-height: var(--target); min-width: 0; max-width: min(46vw, 420px); }
.title-btn { border: 0; background: transparent; font-weight: 650; font-size: 16px; padding: 0 10px; min-height: 40px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title-input { border: 0; outline: none; background: transparent; font-weight: 650; font-size: 16px; padding: 0 10px; min-height: 40px; width: min(320px, 40vw); }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.idle { background: var(--ok); }
.dot.syncing { background: var(--accent); }
.dot.offline, .dot.signed-out { background: var(--warn); }
.dot.error { background: var(--danger); }
.dot.local { background: var(--surface-3); box-shadow: inset 0 0 0 2px var(--muted); }
.actions { display: flex; padding: 0 2px; }
.topbar > .icon-btn.panel { border-radius: 12px; }
.zoom { position: absolute; z-index: 18; left: calc(8px + var(--safe-left)); display: flex; align-items: center; }
.zoom.top { bottom: calc(10px + var(--safe-bottom)); }
.zoom.bottom { top: calc(64px + var(--safe-top)); left: auto; right: calc(8px + var(--safe-right)); }
.zoom-pct { border: 0; background: transparent; min-height: 40px; padding: 0 10px; font-variant-numeric: tabular-nums; font-size: 13px; }
.zen-exit {
  position: absolute; z-index: 26; top: calc(12px + var(--safe-top)); right: calc(12px + var(--safe-right)); min-height: 36px; padding: 0 14px;
  font-size: 13px; color: var(--muted); opacity: 0.75; border-radius: 99px;
}
.zen-exit:hover, .zen-exit:focus-visible { opacity: 1; color: var(--text); }
.icon-btn.small { width: 40px; height: 40px; }
@media (max-width: 520px) {
  .actions .icon-btn { width: 40px; }
  .title { max-width: 38vw; }
}
</style>
