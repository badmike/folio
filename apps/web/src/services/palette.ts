/**
 * Cmd+K palette: jump to pages and notebooks, run menu commands, or ask the AI. The views build the
 * items; this ranks them against the query. "Ask AI: <query>" always closes the list, so Enter on a
 * query that matches nothing asks the AI.
 */
import type { MenuItem } from '../components/Menu.vue'
import type { IconName } from '../icons'

export type PaletteGroup = 'page' | 'notebook' | 'command'

export interface PaletteItem {
  id: string
  label: string
  group: PaletteGroup
  /** Right-aligned context, e.g. "Page" or the parent menu. */
  hint?: string
  icon?: IconName
  run: () => void
}

export type PaletteRow = { kind: 'item'; item: PaletteItem } | { kind: 'ask'; query: string }

const MAX_ROWS = 12
/** Order of the groups when the query is empty. */
const GROUP_ORDER: readonly PaletteGroup[] = ['page', 'notebook', 'command']

/**
 * How well `query` matches `text`, higher is better, null for no match. Prefix beats word start beats
 * substring beats a loose subsequence (each query character in order, gaps cost).
 */
export function matchScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  if (t.startsWith(q)) return 100 - Math.min(20, t.length - q.length) / 2
  const at = t.indexOf(q)
  if (at > 0) return /[\s\-_/(.]/.test(t[at - 1]) ? 80 : 60
  let gaps = 0
  let ti = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const next = t.indexOf(ch, ti)
    if (next < 0) return null
    if (next > ti) gaps++
    ti = next + 1
  }
  return Math.max(1, 40 - gaps * 4)
}

/** Ranked rows for `query`: matches first, then the Ask AI row (only with a query and `ask`). */
export function rankPalette(items: readonly PaletteItem[], query: string, ask = true): PaletteRow[] {
  const q = query.trim()
  if (!q) {
    const order = (i: PaletteItem) => GROUP_ORDER.indexOf(i.group)
    return [...items].sort((a, b) => order(a) - order(b)).slice(0, MAX_ROWS).map((item) => ({ kind: 'item', item }))
  }
  const rows: PaletteRow[] = items
    .flatMap((item) => {
      const score = matchScore(q, item.label)
      return score === null ? [] : [{ item, score }]
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ROWS - 1)
    .map(({ item }) => ({ kind: 'item', item }))
  return ask ? [...rows, { kind: 'ask', query: q }] : rows
}

/** The runnable entries of a menu, submenus flattened with their parent as the hint. */
export function menuCommands(items: readonly MenuItem[], parent?: { label: string; icon?: IconName }): PaletteItem[] {
  return items.flatMap((m): PaletteItem[] => {
    if (m.divider || m.disabled || !m.label) return []
    const label = m.label.replace(/…$/, '')
    if (m.children) return menuCommands(m.children, { label, icon: m.icon })
    const action = m.action
    if (!action) return []
    const state = m.checked === undefined ? '' : m.checked ? ' (on)' : ' (off)'
    return [{ id: `cmd:${parent?.label ?? ''}/${label}`, label: label + state, group: 'command', hint: parent?.label, icon: m.icon ?? parent?.icon ?? 'menu', run: action }]
  })
}
