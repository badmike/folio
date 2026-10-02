<script setup lang="ts">
import type { BackgroundPattern, NotebookEntry } from '@folio/document'
import type { SearchHit } from '@folio/persistence'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { requireServices } from '../app'
import FolderTree from '../components/FolderTree.vue'
import Icon from '../components/Icon.vue'
import Logo from '../components/Logo.vue'
import Menu, { type MenuItem } from '../components/Menu.vue'
import NewNotebookDialog from '../components/NewNotebookDialog.vue'
import NotebookCard from '../components/NotebookCard.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { renderSnippet, useLibrary } from '../composables'
import { diagnostics } from '../services/diagnostics'
import { chooseDialog, confirmDialog, promptDialog } from '../services/dialogs'
import { exportFolioFile, exportMarkdownFor, importNotebookFile } from '../services/export'
import { isIosSafariNotInstalled, offlineReady } from '../services/pwa'
import type { DefaultPageType } from '../services/settings'
import { toast, toastError } from '../services/toast'

const router = useRouter()
const { workspace: ws, auth, sync } = requireServices()
const { folders, notebooks, tags } = useLibrary(ws)

type Sort = 'modified' | 'created' | 'title'
const readPref = <T,>(k: string, d: T): T => { try { return (localStorage.getItem(k) as T | null) ?? d } catch { return d } }
const sort = ref<Sort>(readPref<Sort>('folio.sort', 'modified'))
watch(sort, (v) => { try { localStorage.setItem('folio.sort', v) } catch { /* ignore */ } })
const selected = ref<string>('all')
const tagFilter = ref<string | null>(null)
const showNew = ref(false)
const showSettings = ref(false)
const drawer = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const SORTS: Record<Sort, string> = { modified: 'Last modified', created: 'Date created', title: 'Title' }
const sortItems = computed<MenuItem[]>(() => (Object.keys(SORTS) as Sort[]).map((k) => ({ label: SORTS[k], checked: sort.value === k, action: () => (sort.value = k) })))

// ---- listing ------------------------------------------------------------------
const visible = computed(() => {
  let list = notebooks.value.filter((n) => selected.value === 'all' || n.folderId === selected.value)
  if (tagFilter.value) list = list.filter((n) => n.tags.includes(tagFilter.value!))
  const s = sort.value
  return [...list].sort((a, b) =>
    s === 'title' ? (a.title || '').localeCompare(b.title || '') : s === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt)
})
const counts = computed(() => {
  const c: Record<string, number> = { all: notebooks.value.length }
  for (const n of notebooks.value) if (n.folderId) c[n.folderId] = (c[n.folderId] ?? 0) + 1
  return c
})
const heading = computed(() => (selected.value === 'all' ? 'All notebooks' : folders.value.find((f) => f.id === selected.value)?.name ?? 'Notebooks'))
watch(folders, (fs) => { if (selected.value !== 'all' && !fs.some((f) => f.id === selected.value)) selected.value = 'all' })

// ---- search ---------------------------------------------------------------------
const query = ref('')
const hits = ref<SearchHit[]>([])
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined
let searchSeq = 0
watch(query, (q) => {
  clearTimeout(searchTimer)
  if (!q.trim()) { hits.value = []; searching.value = false; return }
  searching.value = true
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq
    try {
      const r = await ws.search(q, 60)
      if (seq === searchSeq) hits.value = r
    } catch (e) { diagnostics.log('search', e) }
    if (seq === searchSeq) searching.value = false
  }, 180)
})
onBeforeUnmount(() => clearTimeout(searchTimer))
const titleOf = (id: string) => notebooks.value.find((n) => n.id === id)?.title || 'Untitled'
const liveHits = computed(() => hits.value.filter((h) => notebooks.value.some((n) => n.id === h.notebookId)))
function openHit(h: SearchHit) {
  const q: Record<string, string> = {}
  if (h.pageId) q.page = h.pageId
  if (h.objectId) q.obj = h.objectId
  void router.push({ name: 'notebook', params: { id: h.notebookId }, query: q })
}

// ---- actions ----------------------------------------------------------------------
const open = (id: string) => router.push({ name: 'notebook', params: { id } })

async function createNotebook(o: { title: string; pageType: DefaultPageType; pattern: BackgroundPattern }) {
  showNew.value = false
  try {
    const id = await ws.createNotebook({ ...o, folderId: selected.value === 'all' ? null : selected.value })
    await open(id)
  } catch (e) { diagnostics.log('createNotebook', e); toastError('Could not create the notebook.') }
}

async function rename(n: NotebookEntry) {
  const t = await promptDialog({ title: 'Rename notebook', label: 'Title', value: n.title })
  if (t !== null) await ws.renameNotebook(n.id, t)
}
async function duplicate(n: NotebookEntry) {
  try { await ws.duplicateNotebook(n.id); toast('Notebook duplicated') } catch (e) { diagnostics.log('duplicate', e); toastError('Could not duplicate.') }
}
async function remove(n: NotebookEntry) {
  if (await confirmDialog({ title: 'Delete notebook?', message: `“${n.title || 'Untitled'}” will be removed from your library.`, confirmLabel: 'Delete', danger: true })) {
    await ws.deleteNotebook(n.id)
  }
}
function folderOptions(exclude?: string) {
  const out: { value: string; label: string; depth: number }[] = [{ value: '__root__', label: 'No folder', depth: 0 }]
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.value.filter((x) => x.parentId === parent && x.id !== exclude)) {
      out.push({ value: f.id, label: f.name, depth })
      if (out.length < 500) walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
async function moveNotebook(n: NotebookEntry) {
  const v = await chooseDialog({ title: 'Move to folder', options: folderOptions() })
  if (v !== null) ws.moveNotebook(n.id, v === '__root__' ? null : v)
}
async function editTags(n: NotebookEntry) {
  const v = await promptDialog({ title: 'Tags', label: 'Comma separated', value: n.tags.join(', ') })
  if (v !== null) await ws.setTags(n.id, v.split(','))
}
async function guard(fn: () => Promise<unknown>, msg: string) {
  try { await fn() } catch (e) { diagnostics.log('library.action', e); toastError(msg) }
}
function menuFor(n: NotebookEntry): MenuItem[] {
  return [
    { label: 'Open', icon: 'notebook', action: () => void open(n.id) },
    { label: 'Rename', icon: 'edit', action: () => void rename(n) },
    { label: 'Duplicate', icon: 'copy', action: () => void duplicate(n) },
    { label: 'Move to folder…', icon: 'move', action: () => void moveNotebook(n) },
    { label: 'Edit tags…', icon: 'tag', action: () => void editTags(n) },
    { divider: true },
    { label: 'Export .folio', icon: 'download', action: () => void guard(() => exportFolioFile(ws, n.id, n.title), 'Export failed.') },
    { label: 'Export Markdown', icon: 'doc', action: () => void guard(() => exportMarkdownFor(ws, n.id, n.title), 'Export failed.') },
    { divider: true },
    { label: 'Delete', icon: 'trash', danger: true, action: () => void remove(n) },
  ]
}

// folders
async function newFolder(parentId: string | null) {
  const name = await promptDialog({ title: 'New folder', label: 'Name', confirmLabel: 'Create' })
  if (name !== null) {
    const id = ws.createFolder(name, parentId)
    selected.value = id
  }
}
async function renameFolder(id: string) {
  const f = folders.value.find((x) => x.id === id)
  const name = await promptDialog({ title: 'Rename folder', label: 'Name', value: f?.name ?? '' })
  if (name !== null) ws.renameFolder(id, name)
}
async function moveFolder(id: string) {
  const v = await chooseDialog({ title: 'Move folder to', options: folderOptions(id) })
  if (v === null) return
  if (!ws.moveFolder(id, v === '__root__' ? null : v)) toastError('A folder cannot be moved into itself.')
}
async function deleteFolder(id: string) {
  const f = folders.value.find((x) => x.id === id)
  if (await confirmDialog({ title: 'Delete folder?', message: `“${f?.name}” and its subfolders will be removed. Notebooks inside are kept.`, confirmLabel: 'Delete', danger: true })) {
    ws.deleteFolder(id)
  }
}

// import
async function onImport(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  for (const f of files) {
    try {
      await importNotebookFile(ws, f, selected.value === 'all' ? null : selected.value)
      toast(`Imported “${f.name}”`, { kind: 'success' })
    } catch (err) {
      diagnostics.log('import', err)
      toastError(`Could not import “${f.name}”: ${err instanceof Error ? err.message : 'invalid file'}`)
    }
  }
}

/** Narrow screens: search lives in the drawer. */
async function openSearch() {
  drawer.value = true
  await nextTick()
  searchInput.value?.focus()
}

const syncLabel = computed(() => (sync.uiState.value === 'local' ? '' : sync.uiState.value))
const showIosHint = ref(isIosSafariNotInstalled() && !sessionStorageGet('folio.iosHint'))
function sessionStorageGet(k: string) { try { return sessionStorage.getItem(k) } catch { return null } }
function dismissHint() { showIosHint.value = false; try { sessionStorage.setItem('folio.iosHint', '1') } catch { /* ignore */ } }
</script>

<template>
  <div class="lib">
    <aside class="side" :class="{ open: drawer }">
      <div class="side-top">
        <Logo class="brand" :height="28" />
        <span class="spacer" />
        <button class="icon-btn" aria-label="Settings" title="Settings" data-testid="open-settings" @click="showSettings = true">
          <Icon :name="auth.signedIn.value ? 'cloud' : 'settings'" :size="20" />
          <span v-if="syncLabel" class="sdot" :class="syncLabel" />
        </button>
      </div>
      <label class="search">
        <Icon name="search" :size="16" />
        <input ref="searchInput" v-model="query" type="search" placeholder="Search notebooks"
          aria-label="Search all notebooks" data-testid="search-input" @keydown.enter="drawer = false" />
        <button v-if="query" class="icon-btn mini" aria-label="Clear search" @click="query = ''">
          <Icon name="x" :size="14" />
        </button>
      </label>
      <FolderTree :folders="folders" :selected="selected" :counts="counts"
        @select="(id) => { selected = id; drawer = false; query = '' }" @create="newFolder" @rename="renameFolder"
        @move="moveFolder" @delete="deleteFolder" @drop="(fid, nid) => ws.moveNotebook(nid, fid)" />
      <div v-if="tags.length" class="tagbox">
        <div class="label">Tags</div>
        <div class="tagrow">
          <button v-for="t in tags" :key="t" class="chip" :class="{ on: tagFilter === t }"
            @click="tagFilter = tagFilter === t ? null : t">#{{ t }}</button>
        </div>
      </div>
      <span class="spacer" />
      <div v-if="offlineReady" class="status" title="folio works without a connection" data-testid="offline-ready">
        <Icon name="check" :size="14" /> Offline ready
      </div>
    </aside>
    <div v-if="drawer" class="scrim" @click="drawer = false" />

    <main class="main">
      <header class="head">
        <button class="icon-btn only-narrow" aria-label="Folders" @click="drawer = true"><Icon name="menu" :size="20" /></button>
        <h1 v-if="query.trim()">Search results</h1>
        <h1 v-else>{{ heading }}</h1>
        <span v-if="tagFilter && !query.trim()" class="chip on">#{{ tagFilter }}
          <button class="x" aria-label="Clear tag filter" @click="tagFilter = null"><Icon name="x" :size="12" /></button>
        </span>
        <span class="spacer" />
        <button class="icon-btn only-narrow" aria-label="Search" @click="openSearch"><Icon name="search" :size="20" /></button>
        <template v-if="!query.trim()">
          <Menu align="right" :items="sortItems">
            <button class="btn small ghost sort" aria-label="Sort">
              <span class="hide-narrow">{{ SORTS[sort] }}</span><Icon name="down" :size="14" class="hide-narrow" />
              <Icon name="sort" :size="18" class="only-narrow" />
            </button>
          </Menu>
          <button class="icon-btn" aria-label="Import" title="Import .folio or .excalidraw" data-testid="import-folio" @click="fileInput?.click()">
            <Icon name="upload" :size="20" />
          </button>
          <input ref="fileInput" type="file" accept=".folio,.excalidraw,application/zip,application/json" multiple
            hidden data-testid="import-input" @change="onImport" />
          <button class="btn primary small" data-testid="new-notebook" @click="showNew = true">
            <Icon name="plus" :size="16" /> <span class="hide-narrow">New notebook</span><span class="only-narrow">New</span>
          </button>
        </template>
      </header>

      <div class="content">
        <div v-if="showIosHint" class="hint">
          <Icon name="download" :size="18" />
          <span>Install folio: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong> for the full-screen app.</span>
          <button class="icon-btn mini" aria-label="Dismiss" @click="dismissHint"><Icon name="x" :size="14" /></button>
        </div>

        <section v-if="query.trim()" class="results" data-testid="search-results">
          <p v-if="!searching && !liveHits.length" class="muted" data-testid="no-results">Nothing found for “{{ query }}”.</p>
          <ul>
            <li v-for="(h, i) in liveHits" :key="i">
              <button class="hit" data-testid="search-hit" @click="openHit(h)">
                <span class="hit-title">
                  <Icon :name="h.kind === 'handwriting' ? 'pen' : h.kind === 'tag' ? 'tag' : 'doc'" :size="16" />
                  {{ titleOf(h.notebookId) }}
                  <span class="chip">{{ h.kind }}</span>
                </span>
                <span class="snippet" v-html="renderSnippet(h.snippet)" />
              </button>
            </li>
          </ul>
        </section>

        <template v-else>
          <div v-if="!visible.length" class="empty">
            <Icon name="notebook" :size="36" />
            <p class="muted">No notebooks here yet.</p>
            <button class="btn small" @click="showNew = true"><Icon name="plus" :size="16" /> New notebook</button>
          </div>
          <div class="grid" data-testid="notebook-grid">
            <NotebookCard v-for="n in visible" :key="n.id" :entry="n" :ws="ws" :items="menuFor(n)" @open="open(n.id)"
              @tag="(t) => (tagFilter = t)" />
          </div>
        </template>
      </div>
    </main>

    <NewNotebookDialog v-if="showNew" @close="showNew = false" @create="createNotebook" />
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.lib {
  height: 100%;
  display: flex;
  background: var(--sidebar);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}

/* ---- sidebar: the frame (L0) ---- */
.side {
  width: 248px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: calc(10px + var(--safe-top)) 10px calc(10px + var(--safe-bottom));
  overflow: auto;
  background: var(--sidebar);
  border-right: 1px solid var(--border);
}

.side-top {
  display: flex;
  align-items: center;
  padding-left: 8px;
}

.brand {
  color: var(--text-strong);
}

.sdot {
  position: absolute;
  right: 9px;
  top: 9px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 2px var(--sidebar);
}

.sdot.syncing {
  background: var(--accent);
}

.sdot.offline,
.sdot.signed-out {
  background: var(--warn);
}

.sdot.error {
  background: var(--danger);
}

.search {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 4px 0 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  cursor: text;
}

.search:focus-within {
  border-color: var(--accent);
}

.search input {
  flex: 1;
  min-width: 0;
  min-height: 34px;
  border: 0;
  background: transparent;
  outline: none;
  font-size: 14px;
  color: var(--text-strong);
}

.search input::-webkit-search-cancel-button {
  display: none;
}

.tagbox {
  padding: 4px 10px 0;
}

.label {
  font-size: 12px;
  font-weight: 600;
}

.tagrow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--muted);
}

.status svg {
  color: var(--ok);
}

/* ---- main: the canvas (L1) ---- */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: calc(60px + var(--safe-top));
  padding: var(--safe-top) 20px 0 28px;
  border-bottom: 1px solid var(--border);
}

.head h1 {
  font-size: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head .chip {
  font-size: 12.5px;
  padding: 2px 4px 2px 10px;
}

.chip .x {
  display: inline-flex;
  padding: 2px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
}

.sort {
  gap: 4px;
  color: var(--muted);
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px 28px calc(28px + var(--safe-bottom));
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 20px;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 72px 0;
  color: var(--muted);
}

.empty p {
  margin: 0 0 6px;
}

.hint {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 6px 6px 14px;
  margin-bottom: 20px;
  border-radius: var(--radius-lg);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.hint span {
  flex: 1;
  font-size: 14px;
}

.mini {
  width: 28px;
  height: 28px;
}

.results ul {
  list-style: none;
  max-width: 760px;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hit {
  width: 100%;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--surface);
}

.hit:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow);
}

.hit-title {
  font-weight: 600;
  color: var(--text-strong);
  display: flex;
  align-items: center;
  gap: 6px;
}

.snippet {
  color: var(--muted);
  overflow-wrap: anywhere;
}

.only-narrow,
.scrim {
  display: none;
}

@media (max-width: 760px) {
  .only-narrow {
    display: inline-flex;
  }

  .hide-narrow {
    display: none;
  }

  .side {
    position: fixed;
    z-index: 500;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(280px, 85vw);
    transform: translateX(-102%);
    transition: transform 0.18s;
    box-shadow: var(--shadow);
  }

  .side.open {
    transform: none;
  }

  .scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 400;
    background: rgba(10, 10, 20, 0.35);
  }

  .head {
    padding: var(--safe-top) 10px 0 6px;
    min-height: calc(56px + var(--safe-top));
  }

  .content {
    padding: 16px 14px calc(24px + var(--safe-bottom));
  }

  .grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px;
  }
}
</style>
