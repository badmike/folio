import { NotebookDocument, createId, type InkStroke, type Recognition } from '@folio/document'
import { MemoryStorage } from '@folio/persistence'
import { describe, expect, it, vi } from 'vitest'
import type { Editor } from '@folio/editor'
import { renderSnippet } from '../src/composables'
import { contextForPage, placementForAiOutput, aiDisabledReason } from '../src/services/ai'
import { clerkFrontendApi } from '../src/services/auth'
import { exportBounds, safeFilename } from '../src/services/export'
import { RecognitionService } from '../src/services/recognition'
import { DEFAULT_SETTINGS, bindSettings, sanitizeSettings, settings } from '../src/services/settings'
import { Workspace } from '../src/services/workspace'
import { welcomeOperations } from '../src/services/welcome'
import { ref } from 'vue'

describe('settings', () => {
  it('sanitizes stored data, falling back to defaults', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    const s = sanitizeSettings({ cleanupMode: 'auto', theme: 'weird', languages: ['de', 'x', 5], cloudRefinement: 'yes', defaultPageType: 'A4' })
    expect(s.cleanupMode).toBe('auto')
    expect(s.theme).toBe('rough')
    expect(s.languages).toEqual(['de'])
    expect(s.cloudRefinement).toBe(false)
    expect(s.defaultPageType).toBe('A4')
  })

  it('persists changes through storage', async () => {
    const storage = new MemoryStorage()
    const stop = await bindSettings(storage)
    settings.cleanupMode = 'ask'
    settings.languages = ['en']
    await new Promise((r) => setTimeout(r, 400))
    stop()
    expect(await storage.getSetting('settings')).toMatchObject({ cleanupMode: 'ask', languages: ['en'] })
    Object.assign(settings, DEFAULT_SETTINGS)
  })
})

describe('auth helpers', () => {
  it('derives the Clerk frontend API from the publishable key', () => {
    const key = 'pk_test_' + btoa('clerk.example.accounts.dev$')
    expect(clerkFrontendApi(key)).toBe('clerk.example.accounts.dev')
    expect(clerkFrontendApi('pk_test_%%%')).toBeNull()
    expect(clerkFrontendApi('garbage')).toBeNull()
  })
})

describe('search snippets', () => {
  it('escapes HTML before turning markers into <mark>', () => {
    expect(renderSnippet('a <script>alert(1)</script> «hit» & more')).toBe('a &lt;script&gt;alert(1)&lt;/script&gt; <mark>hit</mark> &amp; more')
    expect(renderSnippet('«<b>x</b>»')).toBe('<mark>&lt;b&gt;x&lt;/b&gt;</mark>')
  })
})

describe('ai helpers', () => {
  const full = 'NOTEBOOK "T" (2 pages)\n--- PAGE 1 [infinite]\nfirst\n--- PAGE 2 [infinite]\nsecond\nmore'
  it('reduces context to one page', () => {
    expect(contextForPage(full, 1)).toBe('NOTEBOOK "T" (2 pages)\n--- PAGE 2 [infinite]\nsecond\nmore')
    expect(contextForPage(full, 0)).toBe('NOTEBOOK "T" (2 pages)\n--- PAGE 1 [infinite]\nfirst')
    expect(contextForPage(full, 7)).toBe(full)
  })

  it('places output right of content on infinite pages and inside fixed pages', () => {
    const inf = NotebookDocument.create({ title: 'x' })
    const pid = inf.pages()[0].id
    expect(placementForAiOutput(inf, pid)).toEqual({ x: 0, y: 0, width: 480 })
    inf.apply(welcomeOperations(pid))
    const p = placementForAiOutput(inf, pid)
    const right = Math.max(...inf.objects(pid).map((o) => o.transform.x))
    expect(p.x).toBeGreaterThan(right)
    expect(p.width).toBe(480)

    const fixed = NotebookDocument.create({ title: 'y' })
    const fp = fixed.pages()[0]
    fixed.apply([{ type: 'updatePage', pageId: fp.id, patch: { kind: 'fixed', width: 794, height: 1123 } }])
    const q = placementForAiOutput(fixed, fp.id)
    expect(q.x).toBe(40)
    expect(q.x + q.width).toBeLessThanOrEqual(794)
  })

  it('explains why AI is unavailable', () => {
    const auth = { signedIn: ref(false), online: ref(true) } as never
    // no VITE_API_BASE in tests -> needs a server
    expect(aiDisabledReason(auth)).toMatch(/server/)
  })
})

describe('export helpers', () => {
  it('builds safe filenames', () => {
    expect(safeFilename('a/b:c*?', 'md')).toBe('a b c.md')
    expect(safeFilename('   ', 'png')).toBe('notebook.png')
    expect(safeFilename('x'.repeat(200), 'pdf').length).toBe(84)
  })

  it('exports fixed pages at page size and infinite pages at padded content bounds', () => {
    const doc = NotebookDocument.create({ title: 'x' })
    const page = doc.pages()[0]
    expect(exportBounds(doc, page)).toEqual({ x: 0, y: 0, width: 800, height: 600 }) // empty
    doc.apply(welcomeOperations(page.id))
    const b = exportBounds(doc, page, 10)
    expect(b.width).toBeGreaterThan(400)
    expect(b.x).toBeLessThan(-330)
    expect(exportBounds(doc, { ...page, kind: 'fixed', width: 794, height: 1123 })).toEqual({ x: 0, y: 0, width: 794, height: 1123 })
  })
})

describe('recognition storage', () => {
  const stroke = (id: string): InkStroke => ({
    id, type: 'ink', z: 1, createdAt: 1, updatedAt: 1, transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    points: [0, 0, 1, 0, 0, 0, 10, 10, 1, 0, 0, 5], style: { tool: 'pen', color: '#000', width: 2, opacity: 1, pressureSensitive: false },
    startedAt: 1, pointerType: 'mouse',
  })
  const rec = (id: string, ids: string[], text: string): Recognition => ({
    id, kind: 'text', strokeIds: ids, bounds: { x: 0, y: 0, width: 10, height: 10 }, text, confidence: 0.9, recognizer: 't', createdAt: Date.now(),
  })

  it('batches recognition after a writing pause instead of scanning the page per stroke', async () => {
    const ws = await Workspace.open(new MemoryStorage())
    const id = await ws.createNotebook({ title: 'R' })
    const session = await ws.openNotebook(id)
    const pageId = session.doc.pages()[0].id
    const a = stroke(createId()), b = stroke(createId())
    session.apply([{ type: 'addObjects', pageId, objects: [a, b] }])
    const svc = new RecognitionService()
    const recognize = vi.spyOn(svc, 'recognize').mockResolvedValue([])
    const store = vi.spyOn(svc, 'storeRecognitions')
    const queryRect = vi.fn(() => [a, b])
    const editor = { root: document.createElement('div'), pageId, queryRect } as unknown as Editor
    const attached = svc.attach(editor, session)
    vi.useFakeTimers()
    try {
      attached.onStrokeCommitted(pageId, a)
      await vi.advanceTimersByTimeAsync(500)
      attached.onStrokeCommitted(pageId, b)
      expect(queryRect).not.toHaveBeenCalled()
      expect(recognize).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(700)
      expect(recognize).toHaveBeenCalledTimes(1)
      expect(recognize.mock.calls[0][2].map((s) => s.id).sort()).toEqual([a.id, b.id].sort())
      expect(store).toHaveBeenCalledTimes(1)
    } finally {
      attached.detach()
      vi.useRealTimers()
      await ws.dispose()
    }
  })

  it('stores recognitions non-destructively, replaces regrouped ones and ignores deleted strokes', async () => {
    const ws = await Workspace.open(new MemoryStorage())
    const id = await ws.createNotebook({ title: 'R' })
    const s = await ws.openNotebook(id)
    const pid = s.doc.pages()[0].id
    const a = createId(), b = createId()
    s.apply([{ type: 'addObjects', pageId: pid, objects: [stroke(a), stroke(b)] }])
    const svc = new RecognitionService()

    svc.storeRecognitions(s, pid, [rec('r1', [a], 'he')])
    expect(s.doc.recognitions(pid).map((r) => r.text)).toEqual(['he'])
    // the group grew: the old recognition is stale and gets replaced
    svc.storeRecognitions(s, pid, [rec('r2', [a, b], 'hello')])
    expect(s.doc.recognitions(pid).map((r) => [r.id, r.text])).toEqual([['r2', 'hello']])
    // recognitions for strokes that no longer exist are dropped
    svc.storeRecognitions(s, pid, [rec('r3', ['missing'], 'ghost')])
    expect(s.doc.recognitions(pid).map((r) => r.id)).toEqual(['r2'])
    // ink itself is untouched
    expect(s.doc.objects(pid).filter((o) => o.type === 'ink')).toHaveLength(2)
    expect(s.doc.objects(pid).every((o) => !o.supersededBy)).toBe(true)
  })
})
