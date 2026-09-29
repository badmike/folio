import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('bundle hygiene', () => {
  it('only imports types from the @folio/document barrel (it pulls in loro, ~4 MB, into the worker)', () => {
    for (const file of walk(join(__dirname, '../src'))) {
      const bad = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => /^import\s+(?!type\b)[^']*from '@folio\/document'/.test(l))
      expect(bad, file).toEqual([])
    }
  })
})
