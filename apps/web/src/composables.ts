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

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]]
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "just now", "5 minutes ago", "yesterday", "2 months ago". */
export function timeAgo(ts: number, now = Date.now()): string {
  const secs = Math.round((ts - now) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(secs) >= size) return relative.format(Math.round(secs / size), unit)
  }
  return 'just now'
}
