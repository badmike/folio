import type { FolderEntry, NotebookEntry } from '@folio/document'
import { onBeforeUnmount, shallowRef, type ShallowRef } from 'vue'
import type { Workspace } from './services/workspace'

/** Reactive view of the workspace index (folders + notebooks). */
export function useLibrary(ws: Workspace): {
  folders: ShallowRef<FolderEntry[]>
  notebooks: ShallowRef<NotebookEntry[]>
  tags: ShallowRef<string[]>
} {
  const folders = shallowRef<FolderEntry[]>(ws.folders())
  const notebooks = shallowRef<NotebookEntry[]>(ws.notebooks())
  const tags = shallowRef<string[]>(ws.allTags())
  const refresh = () => {
    folders.value = ws.folders()
    notebooks.value = ws.notebooks()
    tags.value = ws.allTags()
  }
  const off = ws.onChange(refresh)
  onBeforeUnmount(off)
  return { folders, notebooks, tags }
}

/** Render a search snippet: escape HTML first, then turn «match» markers into <mark>. */
export function renderSnippet(snippet: string, open = '«', close = '»'): string {
  const esc = snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  return esc.split(open).join('<mark>').split(close).join('</mark>')
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' })
}
