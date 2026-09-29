import { describe, expect, it } from 'vitest'
import { createDiagnostics } from '../src/diagnostics'
import { normalize, tokenize, toFtsQuery } from '../src/text'

describe('text helpers', () => {
  it('normalizes diacritics and case', () => {
    expect(normalize('Übung ÉCOLE Ångström')).toBe('ubung ecole angstrom')
    expect(tokenize('Hello, Wörld! 42')).toEqual(['hello', 'world', '42'])
  })
  it('builds safe FTS queries', () => {
    expect(toFtsQuery('foo "bar')).toBe('"foo" "bar"*')
    expect(toFtsQuery('***')).toBeNull()
  })
})

describe('diagnostics', () => {
  it('keeps a bounded ring and exports JSON', () => {
    const d = createDiagnostics(3)
    for (let i = 0; i < 5; i++) d.log('src', new Error(`e${i}`), { docId: 'x' })
    const j = JSON.parse(d.exportJson())
    expect(j.entries.map((e: any) => e.message)).toEqual(['Error: e2', 'Error: e3', 'Error: e4'])
    d.clear()
    expect(d.entries()).toEqual([])
  })
})
