<script setup lang="ts">
import type { BackgroundPattern, NotebookEntry } from '@folio/document'
import type { SearchHit } from '@folio/persistence'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { requireServices } from '../app'
import FolderTree from '../components/FolderTree.vue'
import Icon from '../components/Icon.vue'
import Menu, { type MenuItem } from '../components/Menu.vue'
import NewNotebookDialog from '../components/NewNotebookDialog.vue'
import NotebookCard from '../components/NotebookCard.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { renderSnippet, useLibrary } from '../composables'
import { chooseDialog, confirmDialog, promptDialog } from '../services/dialogs'
import { exportFolioFile, exportMarkdownFor, importFolioFile } from '../services/export'
import { offlineReady, isIosSafariNotInstalled } from '../services/pwa'
import type { DefaultPageType } from '../services/settings'
import { toast, toastError } from '../services/toast'
import { diagnostics } from '../services/diagnostics'

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
      await importFolioFile(ws, f, selected.value === 'all' ? null : selected.value)
      toast(`Imported “${f.name}”`, { kind: 'success' })
    } catch (err) {
      diagnostics.log('import', err)
      toastError(`Could not import “${f.name}”: ${err instanceof Error ? err.message : 'invalid file'}`)
    }
  }
}

const syncLabel = computed(() => (sync.uiState.value === 'local' ? '' : sync.uiState.value))
const showIosHint = ref(isIosSafariNotInstalled() && !sessionStorageGet('folio.iosHint'))
function sessionStorageGet(k: string) { try { return sessionStorage.getItem(k) } catch { return null } }
function dismissHint() { showIosHint.value = false; try { sessionStorage.setItem('folio.iosHint', '1') } catch { /* ignore */ } }
</script>

<template>
  <div class="lib">
    <header class="top">
      <button class="icon-btn only-narrow" aria-label="Folders" @click="drawer = !drawer"><Icon name="folder" /></button>
      <div class="brand"><Icon name="logo" :size="26" /><span>folio</span></div>
      <div class="search">
        <Icon name="search" :size="18" />
        <input v-model="query" type="search" placeholder="Search notes, handwriting, labels…" aria-label="Search all notebooks" data-testid="search-input" />
        <button v-if="query" class="icon-btn mini" aria-label="Clear search" @click="query = ''"><Icon name="x" :size="16" /></button>
      </div>
      <span v-if="offlineReady" class="badge" title="folio works without a connection" data-testid="offline-ready"><Icon name="check" :size="14" /> Offline ready</span>
      <button class="icon-btn" aria-label="Settings" data-testid="open-settings" @click="showSettings = true">
        <Icon :name="auth.signedIn.value ? 'cloud' : 'settings'" />
        <span v-if="syncLabel" class="sdot" :class="syncLabel" />
      </button>
    </header>

    <div class="body">
      <aside class="side" :class="{ open: drawer }">
        <FolderTree :folders="folders" :selected="selected" :counts="counts"
                    @select="(id) => { selected = id; drawer = false; query = '' }"
                    @create="newFolder" @rename="renameFolder" @move="moveFolder" @delete="deleteFolder"
                    @drop="(fid, nid) => ws.moveNotebook(nid, fid)" />
        <div v-if="tags.length" class="tagbox">
          <div class="label">Tags</div>
          <div class="tagrow">
            <button v-for="t in tags" :key="t" class="chip" :class="{ on: tagFilter === t }" @click="tagFilter = tagFilter === t ? null : t">{{ t }}</button>
          </div>
        </div>
      </aside>
      <div v-if="drawer" class="scrim" @click="drawer = false" />

      <main class="main">
        <div v-if="showIosHint" class="hint panel">
          <Icon name="download" :size="20" />
          <span>Install folio: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong> for the full-screen app.</span>
          <button class="icon-btn mini" aria-label="Dismiss" @click="dismissHint"><Icon name="x" :size="16" /></button>
        </div>

        <!-- search results -->
        <section v-if="query.trim()" class="results" data-testid="search-results">
          <h2>Search results</h2>
          <p v-if="!searching && !liveHits.length" class="muted" data-testid="no-results">Nothing found for “{{ query }}”.</p>
          <ul>
            <li v-for="(h, i) in liveHits" :key="i">
              <button class="hit" data-testid="search-hit" @click="openHit(h)">
                <span class="hit-title"><Icon :name="h.kind === 'handwriting' ? 'pen' : h.kind === 'tag' ? 'tag' : 'doc'" :size="16" /> {{ titleOf(h.notebookId) }}
                  <span class="chip">{{ h.kind }}</span></span>
                <span class="snippet" v-html="renderSnippet(h.snippet)" />
              </button>
            </li>
          </ul>
        </section>

        <template v-else>
          <div class="bar">
            <h2>{{ heading }}<span v-if="tagFilter" class="chip on tagsel">{{ tagFilter }} <button class="x" aria-label="Clear tag filter" @click="tagFilter = null">×</button></span></h2>
            <span class="spacer" />
            <Menu align="right" :items="[
              { label: 'Recently modified', checked: sort === 'modified', action: () => (sort = 'modified') },
              { label: 'Recently created', checked: sort === 'created', action: () => (sort = 'created') },
              { label: 'Title', checked: sort === 'title', action: () => (sort = 'title') },
            ]">
              <button class="btn small ghost" aria-label="Sort"><Icon name="sort" :size="18" /> <span class="hide-narrow">Sort</span></button>
            </Menu>
            <button class="btn small" data-testid="import-folio" @click="fileInput?.click()"><Icon name="upload" :size="18" /> <span class="hide-narrow">Import</span></button>
            <input ref="fileInput" type="file" accept=".folio,application/zip" multiple hidden data-testid="import-input" @change="onImport" />
            <button class="btn primary" data-testid="new-notebook" @click="showNew = true"><Icon name="plus" :size="18" /> New notebook</button>
          </div>
          <div v-if="!visible.length" class="empty muted">
            <Icon name="notebook" :size="44" />
            <p>No notebooks here yet.</p>
          </div>
          <div class="grid" data-testid="notebook-grid">
            <NotebookCard v-for="n in visible" :key="n.id" :entry="n" :ws="ws" :items="menuFor(n)" @open="open(n.id)" @tag="(t) => (tagFilter = t)" />
          </div>
        </template>
      </main>
    </div>

    <NewNotebookDialog v-if="showNew" @close="showNew = false" @create="createNotebook" />
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.lib { height: 100%; display: flex; flex-direction: column; padding-left: var(--safe-left); padding-right: var(--safe-right); }
.top { display: flex; align-items: center; gap: 8px; padding: calc(8px + var(--safe-top)) 12px 8px; background: var(--surface); border-bottom: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: 6px; font-weight: 750; font-size: 20px; color: var(--accent-strong); letter-spacing: -0.02em; }
.search { flex: 1; max-width: 560px; margin: 0 auto 0 12px; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 12px; background: var(--surface-2); border-radius: 12px; min-height: var(--target); border: 1px solid transparent; }
.search:focus-within { border-color: var(--accent); background: var(--surface); }
.search input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; min-height: 40px; }
.badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--ok); background: var(--surface-2); padding: 4px 10px; border-radius: 99px; }
.sdot { position: absolute; right: 8px; top: 8px; width: 9px; height: 9px; border-radius: 50%; background: var(--ok); border: 2px solid var(--surface); }
.sdot.syncing { background: var(--accent); }
.sdot.offline, .sdot.signed-out { background: var(--warn); }
.sdot.error { background: var(--danger); }
.body { flex: 1; min-height: 0; display: flex; }
.side { width: 250px; flex: none; padding: 14px 10px; overflow: auto; border-right: 1px solid var(--border); background: var(--surface); }
.tagbox { margin-top: 18px; padding: 0 6px; }
.tagrow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.main { flex: 1; min-width: 0; overflow: auto; padding: 18px 20px calc(24px + var(--safe-bottom)); }
.bar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.bar h2 { font-size: 22px; display: flex; align-items: center; gap: 10px; }
.tagsel .x { border: 0; background: transparent; padding: 0 2px; font-size: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 60px 0; }
.hint { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; margin-bottom: 14px; }
.hint span { flex: 1; font-size: 14px; }
.mini { width: 34px; height: 34px; }
.results h2 { font-size: 20px; margin-bottom: 12px; }
.results ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.hit { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface); }
.hit:hover { border-color: var(--accent); }
.hit-title { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.snippet { color: var(--muted); overflow-wrap: anywhere; }
.only-narrow, .scrim { display: none; }
@media (max-width: 760px) {
  .only-narrow { display: inline-flex; }
  .hide-narrow, .badge { display: none; }
  .brand span { display: none; }
  .side { position: fixed; z-index: 500; top: 0; bottom: 0; left: 0; padding-top: calc(14px + var(--safe-top)); transform: translateX(-102%); transition: transform 0.18s; box-shadow: var(--shadow); }
  .side.open { transform: none; }
  .scrim { display: block; position: fixed; inset: 0; z-index: 400; background: rgba(10, 10, 20, 0.35); }
  .main { padding: 14px 14px calc(24px + var(--safe-bottom)); }
  .grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
}
</style>
