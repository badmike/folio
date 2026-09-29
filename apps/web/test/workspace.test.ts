import { objectsOfType } from './util'
import { MemoryStorage, createMemoryState } from '@folio/persistence'
import { createId, exportMarkdown, type TextObject } from '@folio/document'
import { beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../src/services/workspace'

let ws: Workspace
let state = createMemoryState()
const open = () => Workspace.open(new MemoryStorage(state))

beforeEach(async () => {
  state = createMemoryState()
  ws = await open()
})

function textObj(text: string): TextObject {
  return {
    id: createId(), type: 'text', text, fontSize: 20, fontFamily: 'sans', color: '#000', z: 1,
    createdAt: 1, updatedAt: 1, transform: { x: 10, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
  }
}

describe('first run', () => {
  it('creates the Welcome notebook exactly once', async () => {
    const id = await ws.ensureFirstRun()
    expect(id).toBeTruthy()
    expect(ws.notebooks().map((n) => n.title)).toEqual(['Welcome'])
    expect(await ws.ensureFirstRun()).toBeNull()
    // survives a restart and is not recreated after deletion
    await ws.deleteNotebook(id!)
    await ws.flushAll()
    const again = await open()
    expect(await again.ensureFirstRun()).toBeNull()
    expect(again.notebooks()).toHaveLength(0)
  })

  it('welcome notebook contains a heading, text and a labelled diagram, and is searchable', async () => {
    const id = (await ws.ensureFirstRun())!
    const s = await ws.openNotebook(id)
    const page = s.doc.pages()[0]
    const objs = s.doc.objects(page.id)
    expect(objs.filter((o) => o.type === 'text').length).toBeGreaterThanOrEqual(4)
    expect(objs.filter((o) => o.type === 'shape').map((o) => (o as { kind: string }).kind).sort()).toEqual(['ellipse', 'rectangle'])
    expect(objs.filter((o) => o.type === 'arrow')).toHaveLength(1)
    const hits = await ws.search('Sketch')
    expect(hits.some((h) => h.notebookId === id)).toBe(true)
    await ws.release(id)
  })
})

describe('notebook CRUD', () => {
  it('creates infinite and fixed notebooks with a background', async () => {
    const a = await ws.createNotebook({ title: 'Inf' })
    const b = await ws.createNotebook({ title: 'Paper', pageType: 'A4', pattern: 'ruled' })
    const sa = await ws.openNotebook(a)
    const sb = await ws.openNotebook(b)
    expect(sa.doc.pages()).toHaveLength(1)
    expect(sa.doc.pages()[0].kind).toBe('infinite')
    expect(sb.doc.pages()).toHaveLength(1)
    expect(sb.doc.pages()[0]).toMatchObject({ kind: 'fixed', format: 'A4', width: 794, height: 1123 })
    expect(sb.doc.pages()[0].background.pattern).toBe('ruled')
    expect(ws.entry(b)?.title).toBe('Paper')
  })

  it('renames in both the workspace entry and the notebook meta', async () => {
    const id = await ws.createNotebook({ title: 'Old' })
    await ws.renameNotebook(id, '  New name ')
    expect(ws.entry(id)?.title).toBe('New name')
    const s = await ws.openNotebook(id)
    expect(s.doc.meta().title).toBe('New name')
    expect((await ws.search('New')).some((h) => h.kind === 'title')).toBe(false) // reindex is debounced...
    await ws.reindexNow(id)
    expect((await ws.search('name')).some((h) => h.notebookId === id && h.kind === 'title')).toBe(true) // ...then searchable
  })

  it('duplicates into an independent copy with a new id', async () => {
    const id = await ws.createNotebook({ title: 'Original' })
    const s = await ws.openNotebook(id)
    const pid = s.doc.pages()[0].id
    s.apply([{ type: 'addObjects', pageId: pid, objects: [textObj('shared text')] }])
    const copyId = await ws.duplicateNotebook(id)
    expect(copyId).not.toBe(id)
    expect(ws.entry(copyId)?.title).toBe('Original copy')
    const c = await ws.openNotebook(copyId)
    expect(c.doc.id).toBe(copyId)
    const cp = c.doc.pages()[0].id
    expect(objectsOfType(c.doc, cp, 'text').map((t) => t.text)).toEqual(['shared text'])
    // editing the copy leaves the original alone
    c.apply([{ type: 'addObjects', pageId: cp, objects: [textObj('only in copy')] }])
    expect(objectsOfType(s.doc, pid, 'text')).toHaveLength(1)
    expect(objectsOfType(c.doc, cp, 'text')).toHaveLength(2)
  })

  it('moves notebooks between folders, tags them, and deletes them', async () => {
    const id = await ws.createNotebook({ title: 'N' })
    const f = ws.createFolder('Work')
    ws.moveNotebook(id, f)
    expect(ws.entry(id)?.folderId).toBe(f)
    await ws.setTags(id, ['a', ' b ', 'a', ''])
    expect(ws.entry(id)?.tags).toEqual(['a', 'b'])
    expect(ws.allTags()).toEqual(['a', 'b'])
    await ws.deleteNotebook(id)
    expect(ws.notebooks()).toHaveLength(0)
    expect(await ws.search('N')).toEqual([])
  })

  it('opening an unknown notebook fails cleanly', async () => {
    await expect(ws.openNotebook('nope')).rejects.toThrow(/not found/i)
  })
})

describe('folders', () => {
  it('nests, renames, refuses cycles and keeps notebooks when a folder is deleted', async () => {
    const a = ws.createFolder('A')
    const b = ws.createFolder('B', a)
    const c = ws.createFolder('C', b)
    ws.renameFolder(a, 'Alpha')
    expect(ws.folders().find((f) => f.id === a)?.name).toBe('Alpha')
    expect(ws.moveFolder(a, c)).toBe(false) // into own descendant
    expect(ws.moveFolder(a, a)).toBe(false)
    expect(ws.moveFolder(c, null)).toBe(true)
    expect(ws.folders().find((f) => f.id === c)?.parentId).toBeNull()

    const nb = await ws.createNotebook({ title: 'Inside', folderId: b })
    ws.deleteFolder(b)
    expect(ws.folders().map((f) => f.id).sort()).toEqual([a, c].sort())
    expect(ws.entry(nb)?.folderId).toBe(a) // moved up to the nearest surviving parent
  })
})

describe('persistence & indexing', () => {
  it('journalled edits and workspace changes survive a restart', async () => {
    const id = await ws.createNotebook({ title: 'Persist' })
    const folder = ws.createFolder('F')
    const s = await ws.openNotebook(id)
    const pid = s.doc.pages()[0].id
    s.apply([{ type: 'addObjects', pageId: pid, objects: [textObj('remember me')] }])
    await s.persister.flush()
    await ws.flushAll()

    const again = await open()
    expect(again.entry(id)?.title).toBe('Persist')
    expect(again.folders().map((f) => f.id)).toEqual([folder])
    const s2 = await again.openNotebook(id)
    expect(objectsOfType(s2.doc, pid, 'text').map((t) => t.text)).toEqual(['remember me'])
  })

  it('reindexes after changes (debounced) and on release', async () => {
    const id = await ws.createNotebook({ title: 'Idx' })
    const s = await ws.openNotebook(id)
    const pid = s.doc.pages()[0].id
    s.apply([{ type: 'addObjects', pageId: pid, objects: [textObj('mitochondria powerhouse')] }])
    expect(await ws.search('mitochondria')).toEqual([])
    await ws.release(id) // flushes pending index + touch work
    const hits = await ws.search('mitochondria')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ notebookId: id, pageId: pid, kind: 'text' })
    expect(hits[0].bounds).toBeDefined()
    expect(hits[0].snippet).toContain('«')
    // entry timestamp was touched
    expect(ws.entry(id)!.updatedAt).toBeGreaterThanOrEqual(ws.entry(id)!.createdAt)
  })

  it('announces local changes for sync', async () => {
    const id = await ws.createNotebook({ title: 'Sync' })
    const seen: string[] = []
    ws.onLocalChange((d) => seen.push(d))
    const s = await ws.openNotebook(id)
    s.apply([{ type: 'addObjects', pageId: s.doc.pages()[0].id, objects: [textObj('x')] }])
    ws.createFolder('x')
    expect(seen).toContain(id)
    expect(seen).toContain('workspace')
  })
})

describe('export / import', () => {
  it('markdown export contains the notebook text', async () => {
    const id = await ws.createNotebook({ title: 'MD' })
    const s = await ws.openNotebook(id)
    s.apply([{ type: 'addObjects', pageId: s.doc.pages()[0].id, objects: [textObj('Hello markdown')] }])
    const md = await ws.exportMarkdownText(id)
    expect(md).toContain('Hello markdown')
    expect(md).toBe(exportMarkdown(s.doc))
  })

  it('.folio round trip imports as a new notebook with the same content', async () => {
    const id = await ws.createNotebook({ title: 'Roundtrip', pageType: 'Letter' })
    const s = await ws.openNotebook(id)
    const pid = s.doc.pages()[0].id
    s.apply([{ type: 'addObjects', pageId: pid, objects: [textObj('archived text')] }])
    const bytes = await ws.exportFolioBytes(id)
    const folder = ws.createFolder('Imports')
    const newId = await ws.importFolioBytes(bytes, folder)
    expect(newId).not.toBe(id)
    expect(ws.entry(newId)).toMatchObject({ title: 'Roundtrip', folderId: folder })
    const imp = await ws.openNotebook(newId)
    expect(imp.doc.id).toBe(newId)
    expect(imp.doc.pages()[0]).toMatchObject({ kind: 'fixed', format: 'Letter' })
    expect(objectsOfType(imp.doc, imp.doc.pages()[0].id, 'text').map((t) => t.text)).toEqual(['archived text'])
    await expect(ws.importFolioBytes(new Uint8Array([1, 2, 3]))).rejects.toThrow()
  })
})
