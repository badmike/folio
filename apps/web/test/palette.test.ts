import { describe, expect, it, vi } from 'vitest'
import { menuCommands, rankPalette, type PaletteItem, type PaletteRow } from '../src/services/palette'

const item = (label: string, group: PaletteItem['group'] = 'notebook'): PaletteItem => ({ id: label, label, group, run: () => {} })
const labels = (rows: PaletteRow[]) => rows.map((r) => (r.kind === 'ask' ? `ask:${r.query}` : r.item.label))

describe('palette ranking', () => {
  const items = [item('Linear algebra'), item('Physics: Mechanics'), item('Algebra basics'), item('Calculus guide'), item('Metalgear'), item('Settings', 'command')]

  it('ranks prefix over word start over substring over loose matches, then offers Ask AI', () => {
    expect(labels(rankPalette(items, 'alg'))).toEqual(['Algebra basics', 'Linear algebra', 'Metalgear', 'Calculus guide', 'ask:alg'])
    expect(labels(rankPalette(items, 'phy mech'))).toEqual(['Physics: Mechanics', 'ask:phy mech'])
  })

  it('falls back to Ask AI when nothing matches, and lists groups without it for an empty query', () => {
    expect(rankPalette(items, 'what is an eigenvector?')).toEqual([{ kind: 'ask', query: 'what is an eigenvector?' }])
    expect(labels(rankPalette([item('Settings', 'command'), item('Page 1', 'page'), item('Physics')], '  '))).toEqual(['Page 1', 'Physics', 'Settings'])
  })

  it('flattens menu commands with their parent as the hint', () => {
    const action = vi.fn()
    const cmds = menuCommands([
      { label: 'Rename notebook…', icon: 'edit', action },
      { divider: true },
      { label: 'Export', icon: 'download', children: [{ label: 'PDF', action }] },
      { label: 'Show grid', checked: true, action },
    ])
    expect(cmds.map((c) => [c.label, c.hint, c.icon])).toEqual([
      ['Rename notebook', undefined, 'edit'], ['PDF', 'Export', 'download'], ['Show grid (on)', undefined, 'menu'],
    ])
    cmds[1].run()
    expect(action).toHaveBeenCalledOnce()
  })
})
