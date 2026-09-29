import { describe, expect, it } from 'vitest'
import type { Operation } from '@folio/document'
import type { SearchDoc, Storage } from '../src/contract'

/** A backing store that can be (re)opened several times, simulating app restarts. */
export interface Backing { open(): Promise<Storage> }

const op = (n: number): Operation => ({ type: 'updateMeta', patch: { title: `t${n}` } as never })
const bytes = (...n: number[]) => new Uint8Array(n)
const doc = (nb: string, text: string, extra: Partial<SearchDoc> = {}): SearchDoc => ({
  notebookId: nb, pageId: 'p1', objectId: null, kind: 'text', text, ...extra,
})

/** The same behavioural suite for every Storage implementation. */
export function storageConformance(name: string, makeBacking: () => Promise<Backing> | Backing) {
  describe(`Storage conformance: ${name}`, () => {
    async function setup() {
      const backing = await makeBacking()
      return { backing, s: await backing.open() }
    }

    it('journal: appends in order with increasing seq', async () => {
      const { s } = await setup()
      const a = await s.appendOps('nb', [op(1)])
      const b = await s.appendOps('nb', [op(2), op(3)])
      const c = await s.appendOps('other', [op(9)])
      expect(b).toBeGreaterThan(a)
      expect(c).toBeGreaterThan(b)
      const d = await s.loadDoc('nb')
      expect(d.snapshot).toBeNull()
      expect(d.snapshotSeq).toBe(0)
      expect(d.pendingOps.map((p) => p.seq)).toEqual([a, b])
      expect(d.pendingOps[1].ops).toEqual([op(2), op(3)])
    })

    it('loadDoc of unknown doc is empty', async () => {
      const { s } = await setup()
      expect(await s.loadDoc('nope')).toEqual({ snapshot: null, pendingOps: [], snapshotSeq: 0 })
    })

    it('snapshot compaction removes journal rows <= upToSeq only', async () => {
      const { s } = await setup()
      await s.appendOps('nb', [op(1)])
      const b = await s.appendOps('nb', [op(2)])
      const c = await s.appendOps('nb', [op(3)])
      await s.appendOps('other', [op(4)])
      await s.saveSnapshot('nb', bytes(1, 2, 3), b)
      const d = await s.loadDoc('nb')
      expect(Array.from(d.snapshot!)).toEqual([1, 2, 3])
      expect(d.snapshotSeq).toBe(b)
      expect(d.pendingOps.map((p) => p.seq)).toEqual([c])
      expect((await s.loadDoc('other')).pendingOps).toHaveLength(1)
      // seq keeps growing after compaction, even when the journal is empty
      await s.saveSnapshot('nb', bytes(4), c)
      const e = await s.appendOps('nb', [op(5)])
      expect(e).toBeGreaterThan(c)
      expect((await s.loadDoc('nb')).pendingOps.map((p) => p.seq)).toEqual([e])
    })

    it('stores empty and binary snapshots byte-exactly', async () => {
      const { s } = await setup()
      const all = new Uint8Array(256).map((_, i) => i)
      await s.saveSnapshot('nb', all, 0)
      expect(Array.from((await s.loadDoc('nb')).snapshot!)).toEqual(Array.from(all))
      await s.saveSnapshot('nb', new Uint8Array(0), 0)
      expect((await s.loadDoc('nb')).snapshot?.byteLength ?? 0).toBe(0)
    })

    it('crash recovery: ops appended without snapshot survive a restart', async () => {
      const { backing, s } = await setup()
      await s.saveSnapshot('nb', bytes(7), 0)
      const a = await s.appendOps('nb', [op(1)])
      const b = await s.appendOps('nb', [op(2)])
      const s2 = await backing.open() // "restart"
      const d = await s2.loadDoc('nb')
      expect(Array.from(d.snapshot!)).toEqual([7])
      expect(d.pendingOps.map((p) => p.seq)).toEqual([a, b])
      expect(d.pendingOps[0].ops).toEqual([op(1)])
    })

    it('listDocIds includes docs with only a journal, and deleteDoc removes everything', async () => {
      const { s } = await setup()
      await s.saveSnapshot('a', bytes(1), 0)
      await s.appendOps('b', [op(1)])
      await s.setThumbnail('a', 'data:x')
      await s.setSyncState({ docId: 'a', pushedVersion: bytes(1), pulledSeq: 3 })
      await s.indexNotebook('a', [doc('a', 'hello world')])
      expect(await s.listDocIds()).toEqual(['a', 'b'])
      await s.deleteDoc('a')
      expect(await s.listDocIds()).toEqual(['b'])
      expect(await s.getThumbnail('a')).toBeNull()
      expect(await s.getSyncState('a')).toBeNull()
      expect(await s.search('hello')).toEqual([])
      await s.deleteDoc('b')
      expect((await s.loadDoc('b')).pendingOps).toEqual([])
    })

    it('search: diacritics, case, prefix, German text, snippet', async () => {
      const { s } = await setup()
      await s.indexNotebook('nb', [
        doc('nb', 'Übung macht den Meister', { objectId: 'o1', bounds: { x: 1, y: 2, width: 3, height: 4 } }),
        doc('nb', 'Straßenbahn Fahrplan für München', { objectId: 'o2' }),
        doc('nb', 'Quarterly report', { pageId: 'p2', objectId: 'o3' }),
        doc('nb', 'Mein Notizbuch', { pageId: null, kind: 'title' }),
      ])
      const r1 = await s.search('ubung')
      expect(r1).toHaveLength(1)
      expect(r1[0]).toMatchObject({ notebookId: 'nb', pageId: 'p1', objectId: 'o1', kind: 'text', bounds: { x: 1, y: 2, width: 3, height: 4 } })
      expect(r1[0].snippet).toContain('Übung')
      expect(r1[0].snippet).toMatch(/[«»]/)
      expect((await s.search('ÜBUNG')).length).toBe(1)
      expect((await s.search('munchen')).map((h) => h.objectId)).toEqual(['o2'])
      expect((await s.search('München fahr')).map((h) => h.objectId)).toEqual(['o2']) // prefix on last token
      expect(await s.search('fahr münchen')).toEqual([]) // non-last tokens must match whole words
      expect((await s.search('Quart')).map((h) => h.objectId)).toEqual(['o3'])
      const title = await s.search('notizbuch')
      expect(title[0]).toMatchObject({ kind: 'title', pageId: null, objectId: null })
      expect(await s.search('')).toEqual([])
      expect(await s.search('   ')).toEqual([])
      expect(await s.search('"; DROP TABLE x -- *')).toEqual([]) // hostile input is harmless
      expect(await s.search('meister', 0)).toEqual([])
      expect((await s.search('e', 2)).length).toBeLessThanOrEqual(2)
    })

    it('search: per-page reindex only touches that page; full reindex replaces all', async () => {
      const { s } = await setup()
      await s.indexNotebook('nb', [
        doc('nb', 'alpha one', { pageId: 'p1' }),
        doc('nb', 'alpha two', { pageId: 'p2' }),
      ])
      await s.indexNotebook('other', [doc('other', 'alpha three', { pageId: 'p1' })])
      expect(await s.search('alpha')).toHaveLength(3)
      await s.indexNotebook('nb', [doc('nb', 'beta uno', { pageId: 'p1' })], 'p1')
      expect((await s.search('alpha')).map((h) => h.text).sort()).toEqual(['alpha three', 'alpha two'])
      expect(await s.search('beta')).toHaveLength(1)
      await s.indexNotebook('nb', [doc('nb', 'gamma')])
      expect(await s.search('alpha two')).toEqual([])
      expect((await s.search('alpha')).map((h) => h.notebookId)).toEqual(['other'])
      expect(await s.search('gamma')).toHaveLength(1)
    })

    it('search index survives restart', async () => {
      const { backing, s } = await setup()
      await s.indexNotebook('nb', [doc('nb', 'Persistente Suche')])
      const s2 = await backing.open()
      expect(await s2.search('persistente')).toHaveLength(1)
    })

    it('assets: round-trip bytes and mime, overwrite, missing', async () => {
      const { backing, s } = await setup()
      const data = new Uint8Array(1000).map((_, i) => i % 251)
      await s.putAsset('a1', data, 'image/png')
      expect(await s.getAsset('missing')).toBeNull()
      const got = (await s.getAsset('a1'))!
      expect(got.mimeType).toBe('image/png')
      expect(Array.from(got.bytes)).toEqual(Array.from(data))
      await s.putAsset('a1', bytes(1), 'image/jpeg')
      const s2 = await backing.open()
      const g2 = (await s2.getAsset('a1'))!
      expect(g2.mimeType).toBe('image/jpeg')
      expect(Array.from(g2.bytes)).toEqual([1])
    })

    it('thumbnails, settings, sync state', async () => {
      const { backing, s } = await setup()
      expect(await s.getThumbnail('nb')).toBeNull()
      await s.setThumbnail('nb', 'data:image/png;base64,AAA')
      await s.setThumbnail('nb', 'data:image/png;base64,BBB')
      expect(await s.getThumbnail('nb')).toBe('data:image/png;base64,BBB')

      expect(await s.getSetting('k')).toBeUndefined()
      await s.setSetting('k', { a: [1, 2], b: 'ü' })
      await s.setSetting('n', 0)
      expect(await s.getSetting('k')).toEqual({ a: [1, 2], b: 'ü' })
      expect(await s.getSetting('n')).toBe(0)

      expect(await s.getSyncState('nb')).toBeNull()
      await s.setSyncState({ docId: 'nb', pushedVersion: null, pulledSeq: 5 })
      expect(await s.getSyncState('nb')).toEqual({ docId: 'nb', pushedVersion: null, pulledSeq: 5 })
      await s.setSyncState({ docId: 'nb', pushedVersion: bytes(9, 8), pulledSeq: 6 })

      const s2 = await backing.open()
      expect(await s2.getThumbnail('nb')).toBe('data:image/png;base64,BBB')
      expect(await s2.getSetting('k')).toEqual({ a: [1, 2], b: 'ü' })
      const st = (await s2.getSyncState('nb'))!
      expect(st.pulledSeq).toBe(6)
      expect(Array.from(st.pushedVersion!)).toEqual([9, 8])
    })

    it('concurrent appends keep call order', async () => {
      const { s } = await setup()
      const seqs = await Promise.all([1, 2, 3, 4, 5].map((n) => s.appendOps('nb', [op(n)])))
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
      const d = await s.loadDoc('nb')
      expect(d.pendingOps.map((p) => (p.ops[0] as any).patch.title)).toEqual(['t1', 't2', 't3', 't4', 't5'])
    })
  })
}

export { describe }
