import { describe, expect, it } from 'vitest'
import {
  NotebookDocument, createPage, exportFolio, exportMarkdown, importFolio, migrateManifest,
  searchDocsFor, summarizeForAI, FOLIO_FORMAT_VERSION,
} from '../src'
import { arrow, shape, snapshotState, stroke, text, textRec } from './helpers'
import { zipSync, strToU8 } from 'fflate'

const mk = () => {
  const d = NotebookDocument.create({ title: 'Physics' }, { peerId: 3 })
  return { d, P: d.pages()[0].id }
}

describe('markdown export', () => {
  it('headings, paragraphs, lists, equations in reading order', () => {
    const { d, P } = mk()
    d.apply([{
      type: 'addObjects', pageId: P, objects: [
        // deliberately inserted out of order
        text('- Mass: m', 10, 200), text('Force is proportional to acceleration.', 10, 100),
        text("Newton's Second Law", 10, 10, { fontSize: 40 }),
        text('- Force: F', 10, 170), text('F = ma', 10, 260, { semanticType: 'equation' }),
        text('1. first step', 10, 300), text('2. second step', 10, 325),
      ],
    }])
    expect(exportMarkdown(d)).toBe(
      "# Newton's Second Law\n\nForce is proportional to acceleration.\n\n- Force: F\n- Mass: m\n\n$$F = ma$$\n\n1. first step\n2. second step\n",
    )
  })

  it('reads two columns top-to-bottom, left before right, joins words on a line', () => {
    const { d, P } = mk()
    d.apply([{
      type: 'addObjects', pageId: P, objects: [
        text('Right one', 400, 0), text('Right two', 400, 60),
        text('Left one', 0, 0), text('Left two', 0, 60),
        text('world', 70, 0), // same line as "Left one"
      ],
    }])
    const md = exportMarkdown(d)
    expect(md.indexOf('Left one world')).toBeGreaterThanOrEqual(0)
    expect(md.indexOf('Left two')).toBeLessThan(md.indexOf('Right one'))
    expect(md.indexOf('Right one')).toBeLessThan(md.indexOf('Right two'))
  })

  it('uses recognitions unless their strokes are superseded; refinedText wins', () => {
    const { d, P } = mk()
    const s1 = stroke(0, 0), s2 = stroke(0, 40)
    d.apply([{
      type: 'addObjects', pageId: P, objects: [s1, s2],
    }, {
      type: 'setRecognitions', pageId: P, recognitions: [
        textRec('helo wrld', 0, 0, 80, 16, [s1.id], { refinedText: 'hello world' }),
        textRec('gone', 0, 40, 80, 16, [s2.id]),
      ],
    }])
    expect(exportMarkdown(d)).toContain('hello world')
    expect(exportMarkdown(d)).toContain('gone')
    // clean-up: s2 replaced by a text object
    const t = text('Gone (clean)', 0, 40)
    d.apply([
      { type: 'addObjects', pageId: P, objects: [t] },
      { type: 'updateObjects', pageId: P, patches: [{ id: s2.id, patch: { supersededBy: t.id } }] },
    ])
    const md = exportMarkdown(d)
    expect(md).not.toContain('gone\n')
    expect(md).toContain('Gone (clean)')
  })

  it('reconstructs diagram relationships from labeled shapes and arrows', () => {
    const { d, P } = mk()
    const a = shape(0, 0, 100, 60, { label: 'Client' })
    const b = shape(300, 0, 100, 60)
    const inner = text('Server', 320, 20)
    const c = shape(300, 200, 100, 60, { label: 'DB' })
    d.apply([{
      type: 'addObjects', pageId: P, objects: [
        a, b, inner, c,
        arrow({ start: { x: 100, y: 30 }, end: { x: 300, y: 30 }, startBinding: { objectId: a.id }, endBinding: { objectId: b.id }, label: 'HTTP' }),
        // unbound arrow whose tips sit near b and c
        arrow({ start: { x: 350, y: 65 }, end: { x: 350, y: 198 } }),
      ],
    }])
    const md = exportMarkdown(d)
    expect(md).toContain('### Diagram')
    expect(md).toContain('- Client → Server (HTTP)')
    expect(md).toContain('- Server → DB')
    expect(md).not.toMatch(/^Server$/m) // consumed as the shape label
  })

  it('unlabeled drawings become a [Diagram] placeholder; images become asset links', () => {
    const { d, P } = mk()
    d.apply([{
      type: 'addObjects', pageId: P, objects: [
        stroke(0, 0, 10), stroke(5, 5, 10), // cluster, unrecognised
        { id: 'img1', type: 'image', transform: { x: 0, y: 500, rotation: 0, scaleX: 1, scaleY: 1 }, z: 1, createdAt: 1, updatedAt: 1, assetId: 'asset42', mimeType: 'image/png', width: 100, height: 100 },
      ],
    }])
    const md = exportMarkdown(d)
    expect(md).toContain('[Diagram]')
    expect(md).toContain('![image](asset:asset42)')
  })

  it('adds page headings for multi-page notebooks', () => {
    const { d, P } = mk()
    const p2 = createPage({ order: 2, title: 'Second' })
    d.apply([
      { type: 'addObjects', pageId: P, objects: [text('one', 0, 0)] },
      { type: 'addPage', page: p2 },
      { type: 'addObjects', pageId: p2.id, objects: [text('two', 0, 0)] },
    ])
    expect(exportMarkdown(d)).toBe('## Page 1\n\none\n\n## Second\n\ntwo\n')
  })
})

describe('AI summary and search docs', () => {
  it('summarises semantically', () => {
    const { d, P } = mk()
    const a = shape(0, 0, 100, 60, { label: 'A' }), b = shape(300, 0, 100, 60, { label: 'B' })
    d.apply([{ type: 'addObjects', pageId: P, objects: [text('Title', 0, 100, { fontSize: 40, semanticType: 'heading' }), a, b, arrow({ startBinding: { objectId: a.id }, endBinding: { objectId: b.id } })] }])
    const s = summarizeForAI(d)
    expect(s).toContain('NOTEBOOK "Physics"')
    expect(s).toContain('# Title')
    expect(s).toContain('RELATIONS: A → B')
  })

  it('produces SearchDoc shaped entries', () => {
    const { d, P } = mk()
    const s1 = stroke(0, 0)
    d.apply([
      { type: 'updateMeta', patch: { tags: ['physics', 'notes'] } },
      { type: 'addObjects', pageId: P, objects: [s1, text('hello', 5, 5), shape(0, 0, 10, 10, { label: 'Box' })] },
      { type: 'setRecognitions', pageId: P, recognitions: [textRec('scribble', 1, 2, 30, 10, [s1.id])] },
    ])
    const docs = searchDocsFor(d)
    const kinds = docs.map((x) => x.kind).sort()
    expect(kinds).toEqual(['handwriting', 'label', 'tag', 'tag', 'text', 'title'].sort())
    const hw = docs.find((x) => x.kind === 'handwriting')!
    expect(hw.bounds).toEqual({ x: 1, y: 2, width: 30, height: 10 })
    expect(docs.every((x) => x.notebookId === d.id)).toBe(true)
  })
})

describe('folio format', () => {
  it('round-trips without semantic changes', () => {
    const { d, P } = mk()
    const s = stroke(0, 0, 30)
    d.apply([
      { type: 'addObjects', pageId: P, objects: [s, text('hi', 1, 1)] },
      { type: 'setRecognitions', pageId: P, recognitions: [textRec('hi', 0, 0, 5, 5, [s.id])] },
    ])
    const assets = new Map([['a1', { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png' }]])
    const bytes = exportFolio(d, assets, new Uint8Array([0x89, 0x50]))
    const r = importFolio(bytes)
    expect(snapshotState(r.doc)).toEqual(snapshotState(d))
    expect(r.assets.get('a1')!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(r.assets.get('a1')!.mimeType).toBe('image/png')
    expect(r.manifest).toMatchObject({ format: 'folio', version: FOLIO_FORMAT_VERSION, app: 'com.coderscantina.folio', notebookId: d.id, title: 'Physics', preview: 'preview.png' })
    expect(r.manifest.pages[0]).toMatchObject({ id: P, objectCount: 2 })
    expect(exportMarkdown(r.doc)).toBe(exportMarkdown(d))
  })

  it('newId re-keys the notebook but preserves content', () => {
    const { d, P } = mk()
    d.apply([{ type: 'addObjects', pageId: P, objects: [text('keep', 0, 0)] }])
    const r = importFolio(exportFolio(d, new Map()), { newId: true })
    expect(r.doc.id).not.toBe(d.id)
    expect(r.manifest.notebookId).toBe(r.doc.id)
    expect(r.doc.objects(P)).toEqual(d.objects(P))
    expect(r.doc.meta()).toEqual({ ...d.meta(), id: r.doc.id })
    // survives another snapshot cycle
    expect(NotebookDocument.fromSnapshot(r.doc.exportSnapshot()).id).toBe(r.doc.id)
  })

  it('validates archives and versions', () => {
    expect(() => importFolio(new Uint8Array([1, 2, 3]))).toThrow(/valid archive/)
    expect(() => importFolio(zipSync({ 'x.txt': strToU8('x') }))).toThrow(/manifest/)
    const bad = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'folio', version: 99, notebookId: 'n', title: 't' })) })
    expect(() => importFolio(bad)).toThrow(/newer/)
    expect(() => migrateManifest({ format: 'other', version: 1 })).toThrow()
    expect(migrateManifest({ format: 'folio', version: 1, notebookId: 'n', title: 't' }).assets).toEqual([])
    const noDoc = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'folio', version: 1, notebookId: 'n', title: 't' })) })
    expect(() => importFolio(noDoc)).toThrow(/document\.loro/)
  })
})
