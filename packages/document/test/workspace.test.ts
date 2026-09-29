import { describe, expect, it } from 'vitest'
import { WorkspaceDocument, type FolderEntry, type NotebookEntry } from '../src'

const folder = (id: string, parentId: string | null = null): FolderEntry => ({ id, name: id, parentId, createdAt: 1, updatedAt: 1 })
const nb = (id: string, folderId: string | null): NotebookEntry => ({ id, title: id, folderId, tags: [], createdAt: 1, updatedAt: 1 })

describe('WorkspaceDocument', () => {
  it('upserts and lists', () => {
    const w = new WorkspaceDocument({ peerId: 1 })
    w.upsertFolder(folder('f1'))
    w.upsertNotebook(nb('n1', 'f1'))
    expect(w.folders().map((f) => f.id)).toEqual(['f1'])
    expect(w.notebooks()[0]).toMatchObject({ id: 'n1', folderId: 'f1' })
    w.upsertNotebook({ ...nb('n1', null), title: 'renamed' })
    expect(w.notebooks()[0]).toMatchObject({ title: 'renamed', folderId: null })
  })

  it('deleteNotebook is a soft delete', () => {
    const w = new WorkspaceDocument({ peerId: 1 })
    w.upsertNotebook(nb('n1', null))
    w.deleteNotebook('n1')
    expect(w.notebooks()).toEqual([])
    const w2 = WorkspaceDocument.fromSnapshot(w.exportSnapshot())
    expect(w2.notebooks()).toEqual([])
    expect(JSON.stringify(w2.loro.toJSON())).toContain('"deleted":true')
  })

  it('deleting a folder never loses notebooks (moves to parent/root)', () => {
    const w = new WorkspaceDocument({ peerId: 1 })
    w.upsertFolder(folder('root'))
    w.upsertFolder(folder('mid', 'root'))
    w.upsertFolder(folder('leaf', 'mid'))
    w.upsertNotebook(nb('a', 'mid'))
    w.upsertNotebook(nb('b', 'leaf'))
    w.upsertNotebook(nb('c', 'root'))
    w.deleteFolder('mid')
    expect(w.folders().map((f) => f.id)).toEqual(['root'])
    const byId = Object.fromEntries(w.notebooks().map((n) => [n.id, n.folderId]))
    expect(byId).toEqual({ a: 'root', b: 'root', c: 'root' })
    w.deleteFolder('root')
    expect(w.folders()).toEqual([])
    expect(w.notebooks().map((n) => n.folderId)).toEqual([null, null, null])
  })

  it('concurrent add-into-deleted-folder still shows the notebook', () => {
    const a = new WorkspaceDocument({ peerId: 1 })
    a.upsertFolder(folder('f'))
    const b = WorkspaceDocument.fromSnapshot(a.exportSnapshot(), { peerId: 2 })
    a.deleteFolder('f')
    b.upsertNotebook(nb('n', 'f'))
    a.importUpdates(b.exportUpdates(a.version()))
    b.importUpdates(a.exportUpdates(b.version()))
    for (const w of [a, b]) expect(w.notebooks().map((n) => [n.id, n.folderId])).toEqual([['n', null]])
  })

  it('syncs and notifies', () => {
    const a = new WorkspaceDocument({ peerId: 1 }), b = new WorkspaceDocument({ peerId: 2 })
    const seen: string[] = []
    b.subscribe((o) => seen.push(o))
    a.upsertNotebook(nb('n', null))
    b.importUpdates(a.exportUpdates())
    expect(b.notebooks()).toHaveLength(1)
    expect(seen).toEqual(['remote'])
  })
})
