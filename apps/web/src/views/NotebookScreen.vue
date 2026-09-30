<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { requireServices } from '../app'
import AiPanel from '../components/AiPanel.vue'
import Icon from '../components/Icon.vue'
import Menu, { type MenuItem } from '../components/Menu.vue'
import NotebookSearch from '../components/NotebookSearch.vue'
import PagePanel from '../components/PagePanel.vue'
import PropertiesPanel from '../components/PropertiesPanel.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import ShortcutsDialog from '../components/ShortcutsDialog.vue'
import Toolbar from '../components/Toolbar.vue'
import { NOTEBOOK_KEY, type NotebookController } from '../notebook'
import { promptDialog } from '../services/dialogs'
import { diagnostics } from '../services/diagnostics'
import { exportFolioFile, exportMarkdownFile, exportPdf, exportPng } from '../services/export'
import { hasKeyboard } from '../services/input-mode'
import { settings, toggleZen } from '../services/settings'
import { toast, toastError } from '../services/toast'

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
/** Auto-hide: the HUD goes while the pen is down and returns a moment after it lifts. */
const hudHidden = ref(false)
let hudTimer: ReturnType<typeof setTimeout> | undefined
function onHostPointerDown() {
  if (ctl.highlighted.value) ctl.clearHighlight()
  armFade()
  if (settings.autoHideHud) { clearTimeout(hudTimer); hudHidden.value = true }
}
function onHostPointerUp() {
  if (!settings.autoHideHud) return
  clearTimeout(hudTimer)
  hudTimer = setTimeout(() => { hudHidden.value = false }, 900)
}
watch(() => settings.autoHideHud, (on) => { if (!on) { clearTimeout(hudTimer); hudHidden.value = false } })
watch(zen, (on) => {
  wake()
  if (on) { panel.value = null; showSettings.value = false; ctl.showToolOptions.value = false }
})
const showSettings = ref(false)
const showShortcuts = ref(false)
const excalInput = ref<HTMLInputElement | null>(null)

/** App-level keys (the editor handles tools and editing itself and marks those events as handled). */
function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  const mod = e.metaKey || e.ctrlKey
  if (e.altKey && !mod && e.code === 'KeyZ') { e.preventDefault(); toggleZen(); return }
  if (e.altKey && !mod && e.code === 'KeyR') { e.preventDefault(); ctl.setLocked(!ctl.locked.value); return }
  if (mod && !e.shiftKey && e.key === "'") { e.preventDefault(); ctl.toggleGrid(); return }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); togglePanel('search'); return }
  if (!mod && !e.altKey && e.key === '?') { e.preventDefault(); showShortcuts.value = !showShortcuts.value; return }
  if (e.key === 'Escape' && panel.value) { panel.value = null }
}

// Toolbar goes to the bottom on touch devices / narrow screens, top-centre otherwise.
const narrow = ref(false)
function measureLayout() {
  narrow.value = (window.matchMedia?.('(pointer: coarse)').matches ?? false) || window.innerWidth < 720
}
const placement = computed<'top' | 'bottom'>(() => (narrow.value ? 'bottom' : 'top'))

function togglePanel(p: 'pages' | 'search' | 'ai') {
  panel.value = panel.value === p ? null : p
}

// ---- notebook actions ------------------------------------------------------------
async function rename() {
  const t = await promptDialog({ title: 'Rename notebook', label: 'Title', value: ctl.title.value })
  if (t !== null && t.trim() && t.trim() !== ctl.title.value) {
    ctl.title.value = t.trim()
    await ws.renameNotebook(ctl.id, t.trim())
  }
}
async function back() {
  await router.push('/')
}
const fullscreen = ref(false)
function onFullscreenChange() { fullscreen.value = !!document.fullscreenElement }
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch (e) { diagnostics.log('fullscreen', e) }
}
const canFullscreen = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen
async function onExcalidrawFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const n = await ctl.insertExcalidraw(JSON.parse(await file.text()))
    toast(n ? `Imported ${n} item${n === 1 ? '' : 's'} from “${file.name}”` : 'Nothing to import.', { kind: n ? 'success' : 'info' })
  } catch (err) {
    diagnostics.log('import.excalidraw', err)
    toastError(`Could not import “${file.name}”: ${err instanceof Error ? err.message : 'invalid file'}`)
  }
}

function applyRouteFocus() {
  const page = typeof route.query.page === 'string' ? route.query.page : null
  const obj = typeof route.query.obj === 'string' ? route.query.obj : null
  if (!page && !obj) return
  ctl.focus(page, obj)
}

const onPageHide = () => ctl.flushPending()
// The installed iPad app changes its viewport (status bar, rotation, keyboard) without a window resize.
const onViewport = () => { measureLayout(); ctl.remeasure() }
onMounted(async () => {
  measureLayout()
  window.addEventListener('resize', measureLayout)
  window.visualViewport?.addEventListener('resize', onViewport)
  window.addEventListener('orientationchange', onViewport)
  window.addEventListener('pagehide', onPageHide, true)
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  const page = typeof route.query.page === 'string' ? route.query.page : undefined
  ctl.mount(host.value!, page)
  applyRouteFocus()
})
watch(() => [route.query.page, route.query.obj], applyRouteFocus)
watch(() => settings.theme, (t) => ctl.editor.value?.setTheme(t))
watch(() => settings.penMode, (m) => ctl.editor.value?.setPenMode(m))
onBeforeUnmount(() => {
  window.removeEventListener('resize', measureLayout)
  window.visualViewport?.removeEventListener('resize', onViewport)
  window.removeEventListener('orientationchange', onViewport)
  window.removeEventListener('pagehide', onPageHide, true)
  window.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  clearTimeout(fadeTimer)
  clearTimeout(hudTimer)
  void ctl.destroy().catch((e) => diagnostics.log('notebook.destroy', e))
})

// ---- export ---------------------------------------------------------------------
async function run(fn: () => Promise<unknown>) {
  try { ctl.flushPending(); await fn() } catch (e) { diagnostics.log('export', e); toastError('Export failed.') }
}
const mainItems = computed<MenuItem[]>(() => [
  { label: 'Library', icon: 'library', action: () => void back() },
  { label: 'Rename notebook…', icon: 'edit', action: () => void rename() },
  { divider: true },
  { label: 'Lock notebook', icon: 'lock', checked: ctl.locked.value, action: () => ctl.setLocked(!ctl.locked.value) },
  { label: 'Show grid', icon: 'grid', checked: ctl.gridShown, action: () => ctl.toggleGrid() },
  { label: 'Zen mode', icon: 'zen', checked: settings.zen, action: () => toggleZen() },
  { label: 'Hide interface while drawing', icon: 'compact', checked: settings.autoHideHud, action: () => { settings.autoHideHud = !settings.autoHideHud } },
  ...(canFullscreen ? [{ label: 'Full screen', icon: 'fullscreen', checked: fullscreen.value, action: () => void toggleFullscreen() }] : []),
  { divider: true },
  { label: 'Import from Excalidraw…', icon: 'upload', action: () => excalInput.value?.click() },
  { label: 'Export as Markdown (.md)', icon: 'doc', action: () => void run(async () => exportMarkdownFile(ctl.title.value, await ws.exportMarkdownText(ctl.id))) },
  { label: 'Export page as image (.png)', icon: 'download', action: () => void run(() => exportPng(ctl.doc, ctl.pageId.value, settings.theme, ctl.editor.value)) },
  { label: 'Export as PDF', icon: 'download', action: () => void run(() => exportPdf(ctl.doc, settings.theme)) },
  { label: 'Export as folio file (.folio)', icon: 'download', action: () => void run(() => exportFolioFile(ws, ctl.id, ctl.title.value)) },
  { divider: true },
  ...(hasKeyboard.value ? [{ label: 'Keyboard shortcuts', icon: 'keyboard', action: () => { showShortcuts.value = true } }] : []),
  { label: 'Settings', icon: 'settings', action: () => { showSettings.value = true } },
])

const syncClass = computed(() => sync.uiState.value)
const syncTitle = computed(() => {
  switch (sync.uiState.value) {
    case 'local': return auth.signedIn.value ? 'Not syncing' : 'Saved on this device'
    case 'idle': return 'Synced'
    case 'syncing': return 'Syncing…'
    case 'offline': return 'Offline. Changes are saved locally'
    case 'error': return 'Sync problem'
    default: return 'Sign in to sync'
  }
})
const zoomPct = computed(() => Math.round(ctl.zoom.value * 100))
</script>

<template>
  <div class="screen" :class="{ 'hud-hidden': hudHidden }" data-testid="notebook-screen">
    <div ref="host" class="canvas-host" data-testid="editor-host" @pointerdown.capture="onHostPointerDown" @pointerup.capture="onHostPointerUp" @pointercancel.capture="onHostPointerUp" />

    <header v-if="!zen" class="topbar">
      <Menu :items="mainItems" align="left">
        <template #default="{ open }">
          <button class="icon-btn panel floating menu-btn" :class="{ active: open }" aria-label="Menu" :title="ctl.title.value || 'Untitled'" data-testid="main-menu">
            <Icon name="menu" />
            <span class="dot" :class="syncClass" :title="syncTitle" data-testid="sync-dot" />
          </button>
        </template>
        <template #header>
          <div class="menu-title" data-testid="title">{{ ctl.title.value || 'Untitled' }}</div>
        </template>
      </Menu>
      <span class="spacer" />
      <div class="actions panel floating">
        <button class="icon-btn" :class="{ active: panel === 'search' }" aria-label="Search in notebook" title="Search (⌘F)" data-testid="open-search" @click="togglePanel('search')"><Icon name="search" /></button>
        <button class="icon-btn" :class="{ active: panel === 'pages' }" aria-label="Pages and background" title="Pages" data-testid="open-pages" @click="togglePanel('pages')"><Icon name="layers" /></button>
        <button class="icon-btn" :class="{ active: panel === 'ai' }" aria-label="AI assistant" title="AI assistant" data-testid="open-ai" @click="togglePanel('ai')"><Icon name="sparkles" /></button>
      </div>
    </header>
    <input ref="excalInput" type="file" accept=".excalidraw,application/json" hidden data-testid="excalidraw-input" @change="onExcalidrawFile" />

    <Toolbar :placement="placement" :zen="zen" :faded="zen && faded" @wake="wake" />
    <PropertiesPanel :placement="placement" :zen="zen" :force-compact="hudHidden" />
    <button v-if="zen" class="zen-exit panel floating" data-testid="zen-exit" @click="toggleZen(false)">Exit zen mode</button>

    <div v-if="!zen" class="zoom panel floating" :class="placement">
      <button class="icon-btn small" aria-label="Fit to content" title="Fit (Shift+1)" data-testid="zoom-fit" @click="ctl.fit()"><Icon name="fit" :size="18" /></button>
      <button class="zoom-pct" aria-label="Reset zoom to 100%" title="Reset zoom (⌘0)" data-testid="zoom-pct" @click="ctl.resetZoom()">{{ zoomPct }}%</button>
    </div>

    <template v-if="!zen">
      <PagePanel v-if="panel === 'pages'" @close="panel = null" />
      <NotebookSearch v-else-if="panel === 'search'" @close="panel = null" />
      <AiPanel v-else-if="panel === 'ai'" @close="panel = null" />
    </template>
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
    <ShortcutsDialog v-if="showShortcuts" @close="showShortcuts = false" />
  </div>
</template>

<style scoped>
.screen { position: fixed; inset: 0; overflow: hidden; background: var(--bg); touch-action: none; }
/* auto-hide: everything but the compact properties bar fades out while drawing */
.screen > .topbar, .screen > .zoom, .screen :deep(.dock), .screen :deep(.sheet) { transition: opacity 0.25s; }
.screen.hud-hidden > .topbar, .screen.hud-hidden > .zoom, .screen.hud-hidden :deep(.dock), .screen.hud-hidden :deep(.sheet) { opacity: 0; pointer-events: none; }
.screen.hud-hidden :deep(.dock > *) { pointer-events: none; }
.canvas-host { position: absolute; inset: 0; touch-action: none; }
.topbar {
  position: absolute; z-index: 25; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 8px; pointer-events: none;
  padding: calc(8px + var(--safe-top)) calc(8px + var(--safe-right)) 0 calc(8px + var(--safe-left));
}
.topbar > * { pointer-events: auto; }
.topbar > .spacer { pointer-events: none; }
.menu-btn { width: 44px; height: 44px; }
.menu-title { padding: 6px 12px 8px; font-weight: 650; color: var(--text-strong); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { position: absolute; right: 7px; top: 7px; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); border: 2px solid var(--surface); box-sizing: content-box; }
.dot.idle { background: var(--ok); }
.dot.syncing { background: var(--accent); }
.dot.offline, .dot.signed-out { background: var(--warn); }
.dot.error { background: var(--danger); }
.dot.local { background: var(--surface-3); box-shadow: inset 0 0 0 2px var(--muted); }
.actions { display: flex; padding: 2px; }
.actions .icon-btn { width: 40px; height: 40px; }
.zoom { position: absolute; z-index: 18; left: calc(8px + var(--safe-left)); display: flex; align-items: center; }
.zoom.top { bottom: calc(8px + var(--safe-bottom)); }
.zoom.bottom { top: calc(60px + var(--safe-top)); left: auto; right: calc(8px + var(--safe-right)); }
.zoom-pct { border: 0; background: transparent; min-height: 40px; padding: 0 10px; font-variant-numeric: tabular-nums; font-size: 13px; }
.zen-exit {
  position: absolute; z-index: 26; top: calc(12px + var(--safe-top)); right: calc(12px + var(--safe-right)); min-height: 36px; padding: 0 14px;
  font-size: 13px; color: var(--muted); opacity: 0.75; border-radius: 99px;
}
.zen-exit:hover, .zen-exit:focus-visible { opacity: 1; color: var(--text); }
.icon-btn.small { width: 40px; height: 40px; }
</style>
