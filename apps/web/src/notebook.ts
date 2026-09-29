import {
  createPage, worldBounds,
  type NotebookMeta, type Operation, type Page, type PageBackground, type PageFormat, type PageId, type Rect, type ToolSettings,
} from '@folio/document'
import { createEditor, type Editor, type PenMode, type Tool, type ToolOptionsMap } from '@folio/editor'
import { ref, shallowRef } from 'vue'
import { exportBounds, renderPage } from './services/export'
import { whenFontsReady } from './services/fonts'
import { AttachedRecognition, type RecognitionService } from './services/recognition'
import { settings } from './services/settings'
import type { NotebookSession, Workspace } from './services/workspace'

export interface SelectionInfo {
  count: number
  ink: boolean
  derived: boolean
  text: boolean
  group: boolean
}
const NO_SELECTION: SelectionInfo = { count: 0, ink: false, derived: false, text: false, group: false }

/** Injection key for child components. */
export const NOTEBOOK_KEY = Symbol('notebook') as symbol & { __type?: NotebookController }

const camKey = (nb: string, page: string) => `folio.cam.${nb}.${page}`
function lsGet(k: string): string | null { try { return localStorage.getItem(k) } catch { return null } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* ignore */ } }

/**
 * View-model for the notebook route. Owns the Editor instance (never reactive) and mirrors
 * the few bits of editor state the Vue UI needs into refs. Vue does not own editor state.
 */
export class NotebookController {
  readonly editor = shallowRef<Editor | null>(null)
  readonly title = ref('')
  readonly tool = ref<Tool>('pen')
  readonly options = shallowRef<ToolOptionsMap | null>(null)
  readonly canUndo = ref(false)
  readonly canRedo = ref(false)
  readonly selection = shallowRef<SelectionInfo>(NO_SELECTION)
  readonly zoom = ref(1)
  readonly pages = shallowRef<Page[]>([])
  readonly pageId = ref('')
  readonly editingText = ref(false)
  readonly highlighted = ref(false)

  private rec: AttachedRecognition | null = null
  private offs: (() => void)[] = []
  private toolTimer: ReturnType<typeof setTimeout> | undefined
  private camTimer: ReturnType<typeof setTimeout> | undefined
  private thumbTimer: ReturnType<typeof setTimeout> | undefined
  private lastToolJson = ''
  private destroyed = false

  constructor(
    readonly ws: Workspace,
    readonly session: NotebookSession,
    private readonly recognition: RecognitionService,
  ) {
    this.title.value = session.doc.meta().title
    this.pages.value = session.doc.pages()
    // Meta / page-list changes may arrive without touching the current page (rename, remote edits).
    this.offs.push(session.doc.subscribe((e) => {
      if (e.metaChanged) this.title.value = session.doc.meta().title
      if (e.pagesChanged) {
        const pages = session.doc.pages()
        if (pages !== this.pages.value) this.pages.value = pages
      }
    }))
  }

  get doc() { return this.session.doc }
  get id() { return this.session.id }
  get page(): Page | undefined { return this.doc.page(this.pageId.value) }

  /** Create the editor inside `container` (which must already be laid out). */
  mount(container: HTMLElement, initialPageId?: PageId): Editor {
    const doc = this.doc
    const first = doc.pages()[0]
    const wanted = initialPageId && doc.page(initialPageId) ? initialPageId : lsGet(`folio.page.${this.id}`)
    const pageId = wanted && doc.page(wanted) ? wanted : first.id
    this.pageId.value = pageId

    const editor = createEditor({
      container,
      document: doc,
      pageId,
      theme: settings.theme,
      penMode: settings.penMode as PenMode,
      initialTool: 'pen',
      onOperations: (ops) => this.session.recorded(ops),
      onStrokeCommitted: (pid, stroke) => this.rec?.onStrokeCommitted(pid, stroke),
    })
    this.editor.value = editor
    this.rec = this.recognition.attach(editor, this.session)
    this.restoreToolSettings(editor, doc.meta())
    this.syncTool(editor)
    this.canUndo.value = editor.canUndo
    this.canRedo.value = editor.canRedo
    this.zoom.value = editor.zoom

    this.offs.push(
      editor.on('tool', () => this.onTool(editor)),
      editor.on('history', (h) => { this.canUndo.value = h.canUndo; this.canRedo.value = h.canRedo }),
      editor.on('selection', () => this.onSelection(editor)),
      editor.on('camera', (c) => { this.zoom.value = c.zoom; this.scheduleCamSave() }),
      editor.on('textedit', (t) => { this.editingText.value = t.editing }),
      editor.on('change', (e) => this.onChange(editor, e.pagesChanged, e.metaChanged, e.origin)),
    )
    // Caveat changes text metrics: once loaded, repaint with fresh measurements.
    void whenFontsReady().then(() => { if (!this.destroyed) editor.setTheme(editor.theme) })

    this.restoreCamera(editor)
    return editor
  }

  // ---- restore ---------------------------------------------------------------

  private restoreToolSettings(editor: Editor, meta: NotebookMeta) {
    const t = meta.toolSettings
    if (!t) return
    const { tool: _p, ...pen } = t.pen
    const { tool: _h, ...hl } = t.highlighter
    editor.setToolOptions('pen', pen)
    editor.setToolOptions('highlighter', hl)
    editor.setToolOptions('shape', {
      strokeColor: t.shape.strokeColor, strokeWidth: t.shape.strokeWidth, fillColor: t.shape.fillColor,
      opacity: t.shape.opacity, roughness: t.shape.roughness,
    })
    editor.setToolOptions('eraser', { size: t.eraserSize })
    this.lastToolJson = JSON.stringify(this.currentToolSettings(editor))
  }

  private restoreCamera(editor: Editor) {
    const saved = lsGet(camKey(this.id, this.pageId.value))
    if (saved) {
      try {
        const c = JSON.parse(saved) as { x: number; y: number; zoom: number }
        if ([c.x, c.y, c.zoom].every(Number.isFinite)) return editor.setCamera(c)
      } catch { /* fall through */ }
    }
    this.fitContentOnOpen(editor)
  }

  /** Infinite pages with content: show the content (never zooming in beyond 100%). */
  private fitContentOnOpen(editor: Editor) {
    const page = this.page
    if (!page || page.kind !== 'infinite') return
    const objs = this.doc.objects(page.id)
    if (!objs.some((o) => !o.supersededBy)) return
    const b = exportBounds(this.doc, page, 0)
    editor.zoomToRect(b, 64)
    if (editor.zoom > 1) {
      const vs = editor.viewportSize
      editor.setCamera({ zoom: 1, x: b.x + b.width / 2 - vs.width / 2, y: b.y + b.height / 2 - vs.height / 2 })
    }
  }

  // ---- state mirrors ---------------------------------------------------------

  private syncTool(editor: Editor) {
    this.tool.value = editor.tool
    this.options.value = { ...editor.toolOptions }
  }

  private onTool(editor: Editor) {
    this.syncTool(editor)
    clearTimeout(this.toolTimer)
    this.toolTimer = setTimeout(() => this.persistToolSettings(editor), 800)
  }

  private currentToolSettings(editor: Editor): ToolSettings {
    const o = editor.toolOptions
    return {
      pen: { tool: 'pen', ...o.pen },
      highlighter: { tool: 'highlighter', ...o.highlighter },
      shape: {
        strokeColor: o.shape.strokeColor, strokeWidth: o.shape.strokeWidth, fillColor: o.shape.fillColor,
        opacity: o.shape.opacity, roughness: o.shape.roughness, seed: 1,
      },
      eraserSize: o.eraser.size,
    }
  }

  /** Tool settings are stored with the notebook (non-undoable). */
  private persistToolSettings(editor: Editor) {
    if (this.destroyed) return
    const ts = this.currentToolSettings(editor)
    const json = JSON.stringify(ts)
    if (json === this.lastToolJson) return
    this.lastToolJson = json
    this.session.apply([{ type: 'updateMeta', patch: { toolSettings: ts } }])
  }

  private onSelection(editor: Editor) {
    const ids = editor.selection
    if (!ids.length) { this.selection.value = NO_SELECTION; return }
    const leaves = editor.leavesOf(ids)
    this.selection.value = {
      count: ids.length,
      ink: leaves.some((o) => o.type === 'ink' && !o.supersededBy),
      derived: this.rec?.selectionHasDerived() ?? false,
      text: leaves.some((o) => o.type === 'ink' || o.type === 'text' || ((o.type === 'shape' || o.type === 'arrow') && !!o.label)),
      group: ids.some((id) => editor.getObject(id)?.type === 'group'),
    }
  }

  private onChange(editor: Editor, pagesChanged: boolean, metaChanged: boolean, origin: string) {
    if (pagesChanged || origin === 'remote' || origin === 'load') {
      const pages = this.doc.pages()
      if (pages !== this.pages.value) this.pages.value = pages
      if (!this.doc.page(this.pageId.value) && pages.length) this.setPage(pages[0].id)
    }
    if (metaChanged || origin === 'remote') this.title.value = this.doc.meta().title
    this.onSelection(editor)
    if (origin === 'local') this.scheduleThumb()
  }

  // ---- commands --------------------------------------------------------------

  setTool(t: Tool) { this.editor.value?.setTool(t) }
  setOption<T extends Tool>(tool: T, patch: Partial<ToolOptionsMap[T]>) { this.editor.value?.setToolOptions(tool, patch) }
  undo() { this.editor.value?.undo() }
  redo() { this.editor.value?.redo() }

  setPage(id: PageId) {
    const e = this.editor.value
    if (!e || !this.doc.page(id)) return
    this.saveCameraNow()
    e.setPage(id)
    this.pageId.value = id
    lsSet(`folio.page.${this.id}`, id)
    this.restoreCamera(e)
  }

  /** Non-editor changes (pages, meta): applied directly and persisted, not part of undo. */
  applyDoc(ops: Operation[]) { this.session.apply(ops) }

  addPage(kind: 'infinite' | PageFormat) {
    const pages = this.doc.pages()
    const cur = this.page
    const background: PageBackground = { ...(cur?.background ?? { pattern: 'blank', spacing: 32, opacity: 0.5, color: '#ffffff', lineColor: '#d0d4da' }) }
    const page = kind === 'infinite'
      ? createPage({ kind: 'infinite', order: (pages[pages.length - 1]?.order ?? 0) + 1, background })
      : createPage({ kind: 'fixed', format: kind, order: (pages[pages.length - 1]?.order ?? 0) + 1, background })
    this.applyDoc([{ type: 'addPage', page }])
    this.pages.value = this.doc.pages()
    this.setPage(page.id)
  }

  updatePage(pageId: PageId, patch: Partial<Omit<Page, 'id'>>) {
    this.applyDoc([{ type: 'updatePage', pageId, patch: { ...patch, updatedAt: Date.now() } }])
    this.pages.value = this.doc.pages()
    this.editor.value?.requestRender()
  }

  setBackground(patch: Partial<PageBackground>) {
    const p = this.page
    if (p) this.updatePage(p.id, { background: { ...p.background, ...patch } })
  }

  movePage(pageId: PageId, dir: -1 | 1) {
    const pages = this.doc.pages()
    const i = pages.findIndex((p) => p.id === pageId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= pages.length) return
    // place between the neighbours on the target side
    const before = dir < 0 ? pages[j - 1]?.order : pages[j].order
    const after = dir < 0 ? pages[j].order : pages[j + 1]?.order
    const order = before === undefined ? after! - 1 : after === undefined ? before + 1 : (before + after) / 2
    this.updatePage(pageId, { order })
  }

  deletePage(pageId: PageId) {
    const pages = this.doc.pages()
    if (pages.length <= 1) return
    const idx = pages.findIndex((p) => p.id === pageId)
    const next = pages[idx + 1] ?? pages[idx - 1]
    if (this.pageId.value === pageId) this.setPage(next.id)
    this.applyDoc([{ type: 'deletePage', pageId }])
    this.pages.value = this.doc.pages()
  }

  resetZoom() {
    const e = this.editor.value
    if (!e) return
    const vs = e.viewportSize
    const c = e.screenToWorld({ x: vs.width / 2, y: vs.height / 2 })
    e.setCamera({ zoom: 1, x: c.x - vs.width / 2, y: c.y - vs.height / 2 })
  }
  fit() {
    const e = this.editor.value
    if (!e) return
    if (this.page?.kind === 'fixed') e.fitWidth()
    else e.zoomToFit()
  }

  /** Bounds (world) of an object or recognition on a page, e.g. for search navigation. */
  boundsOf(pageId: PageId, objectId: string): Rect | undefined {
    const doc = this.doc
    const o = doc.object(pageId, objectId)
    if (o) return worldBounds(o, (id) => doc.object(pageId, id))
    return doc.recognitions(pageId).find((r) => r.id === objectId)?.bounds
  }

  /** Jump to a search hit: switch page, zoom to it and highlight it. */
  focus(pageId: PageId | null, objectId: string | null, bounds?: Rect) {
    const e = this.editor.value
    if (!e) return
    if (pageId && pageId !== this.pageId.value && this.doc.page(pageId)) this.setPage(pageId)
    const b = bounds ?? (objectId ? this.boundsOf(e.pageId, objectId) : undefined)
    if (!b) return
    const pad = 12
    const r = { x: b.x - pad, y: b.y - pad, width: Math.max(8, b.width + pad * 2), height: Math.max(8, b.height + pad * 2) }
    e.zoomToRect(r, 120)
    if (e.zoom > 2) e.setCamera({ zoom: 2, x: r.x + r.width / 2 - e.viewportSize.width / 4, y: r.y + r.height / 2 - e.viewportSize.height / 4 })
    e.setHighlights([r])
    this.highlighted.value = true
  }
  clearHighlight() {
    this.editor.value?.setHighlights(undefined)
    this.highlighted.value = false
  }

  // recognition passthrough
  get recognitionApi(): AttachedRecognition | null { return this.rec }

  // ---- persistence of view state ---------------------------------------------

  private scheduleCamSave() {
    clearTimeout(this.camTimer)
    this.camTimer = setTimeout(() => this.saveCameraNow(), 400)
  }
  private saveCameraNow() {
    const e = this.editor.value
    if (!e || this.destroyed) return
    const c = e.camera
    lsSet(camKey(this.id, e.pageId), JSON.stringify({ x: c.x, y: c.y, zoom: c.zoom }))
  }

  private scheduleThumb() {
    clearTimeout(this.thumbTimer)
    this.thumbTimer = setTimeout(() => void this.saveThumbnail(), 10_000)
  }

  /** Small preview of the first page for the library card. */
  async saveThumbnail(): Promise<void> {
    try {
      const first = this.doc.pages()[0]
      if (!first) return
      const b = exportBounds(this.doc, first)
      const scale = Math.min(1, 360 / Math.max(b.width, b.height))
      const blob = await renderPage(this.doc, first.id, { scale, theme: settings.theme, bounds: b })
      const url = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(r.error)
        r.readAsDataURL(blob)
      })
      await this.ws.setThumbnail(this.id, url)
    } catch { /* thumbnails are best effort */ }
  }

  flushPending() { this.editor.value?.flushPending() }

  /** Tear down: commit pending input, save view state + thumbnail, release the notebook. */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    const editor = this.editor.value
    clearTimeout(this.toolTimer); clearTimeout(this.camTimer); clearTimeout(this.thumbTimer)
    if (editor) {
      editor.commitTextEdit()
      editor.flushPending()
      this.persistToolSettings(editor)
      this.saveCameraNow()
    }
    this.destroyed = true
    this.offs.forEach((f) => f())
    this.offs = []
    this.rec?.detach()
    this.editor.value = null
    editor?.destroy()
    await this.saveThumbnail()
    await this.ws.release(this.id)
  }
}
