import type {
  ArrowObject, CanvasObject, DocChangeEvent, GroupObject, InkStroke, NotebookDocumentApi, ObjectId, ObjectPatch,
  Operation, Page, PageId, Rect, ShapeObject, TextObject, Vec2,
} from '@folio/document'
import { arrowHandleSpecs } from '@folio/renderer'
import type { ArrowHandleSpec, Camera, LiveInkLayer, Renderer, Scene, SelectionOverlay, Size, VisualTheme } from '@folio/renderer'
import {
  MAX_ZOOM, MIN_ZOOM, cameraForRect, clampCameraToPage, clampZoom, screenToWorld as s2w, worldToScreen as w2s, zoomCameraAt,
} from './camera'
import { createDefaultLiveLayer, createDefaultRenderer, exportPageImage } from './defaults'
import { Emitter } from './emitter'
import {
  createId, hitTestObject, inflate, localBounds, objectIntersectsLasso, rectsIntersect, resolveArrowEndpoints, unionRects,
  worldBounds, worldToLocal,
} from './geometry'
import { InputController } from './input'
import { HANDLE_IDS, applyPatch, cloneObjects, computeFrame, computeMovePatches } from './manipulate'
import type { ObjectPatchEntry, SelectionFrame } from './manipulate'
import { SpatialIndex } from './spatial-index'
import { TextEditor } from './text-edit'
import {
  applicableFor, defaultItemStyle, derivedToolOptions, itemPatchFromToolOptions, patchForObject, selectionContext,
  strokeToInkWidth, toolContext,
} from './style'
import type {
  CleanupPlan, ClipboardPayload, EditorEvents, EditorOptions, ExecuteOptions, ExportImageOptions, ItemStyle, PenMode,
  SelectionStylePatch, StyleContext, StylePatch, Tool, ToolOptionsMap,
} from './types'

const HISTORY_LIMIT = 500
const COALESCE_WINDOW_MS = 1000

interface HistoryEntry {
  ops: Operation[]
  inverse: Operation[]
  key?: string
  time: number
}
interface PageHistory {
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

/** Process-wide internal clipboard so copy/paste works across editors/pages. */
let internalClipboard: ClipboardPayload | undefined

export function defaultToolOptions(): ToolOptionsMap {
  return {
    pen: { color: '#1e1e1e', width: 2.5, opacity: 1, pressureSensitive: true },
    highlighter: { color: '#ffd43b', width: 18, opacity: 0.35, pressureSensitive: false },
    eraser: { size: 20 },
    select: { mode: 'auto' },
    ...derivedToolOptions(defaultItemStyle(), 'rectangle'),
  }
}

const raf = (cb: () => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number)
const caf = (id: number): void => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))

export class Editor {
  readonly document: NotebookDocumentApi
  readonly events = new Emitter<EditorEvents>()
  readonly root: HTMLDivElement
  readonly sceneCanvas: HTMLCanvasElement
  readonly liveCanvas: HTMLCanvasElement
  readonly domLayer: HTMLDivElement
  /** @internal */ readonly live: LiveInkLayer
  /** @internal */ readonly textEditor: TextEditor
  /** @internal */ readonly opts: EditorOptions

  private renderer: Renderer
  private input: InputController
  private resizeObserver?: ResizeObserver
  private unsubDoc: () => void

  private _pageId: PageId
  private _camera: Camera = { x: 0, y: 0, zoom: 1 }
  private viewport: Size = { width: 0, height: 0, dpr: 1 }
  private needsInitialFit = true
  private _tool: Tool
  /** pen / highlighter / eraser / select / shape.kind live here; shape/arrow/text are derived from _itemStyle. */
  private _toolOptions = defaultToolOptions()
  private _itemStyle: ItemStyle = defaultItemStyle()
  private _toolOptionsView: ToolOptionsMap | undefined
  private _theme: VisualTheme
  private _readOnly: boolean
  private _penMode: PenMode

  // page cache
  private objs = new Map<ObjectId, CanvasObject>()
  private arrowIds = new Set<ObjectId>()
  private index = new SpatialIndex()
  private minZ = 0
  private maxZ = 0

  // selection & interaction state
  private _selection: ObjectId[] = []
  private overrides = new Map<ObjectId, CanvasObject>()
  private previewObjects: CanvasObject[] = []
  private hiddenExtra = new Set<ObjectId>()
  private overlayExtra: Pick<SelectionOverlay, 'marquee' | 'lasso' | 'bindingTargetId'> = {}
  private highlights: Rect[] | undefined
  private hideHandles = false

  // history
  private histories = new Map<PageId, PageHistory>()

  // frame loop
  private dirty = false
  private rafId = 0
  private pendingLiveClear = false
  private pendingStroke?: { pageId: PageId; stroke: InkStroke }
  private pendingTimer: ReturnType<typeof setTimeout> | undefined
  private destroyed = false
  private pasteSerial = 0

  constructor(opts: EditorOptions) {
    this.opts = opts
    this.document = opts.document
    this._pageId = opts.pageId
    this._tool = opts.initialTool ?? 'pen'
    this._theme = opts.theme ?? 'rough'
    this._readOnly = !!opts.readOnly
    this._penMode = opts.penMode ?? 'auto'

    const container = opts.container
    try {
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
    } catch { /* ignore */ }
    if (!container.hasAttribute('tabindex')) container.tabIndex = 0
    container.style.outline = 'none'

    this.root = document.createElement('div')
    this.root.className = 'folio-editor'
    Object.assign(this.root.style, {
      position: 'absolute', inset: '0', overflow: 'hidden', touchAction: 'none', userSelect: 'none',
      webkitUserSelect: 'none', webkitTouchCallout: 'none',
    })
    this.sceneCanvas = this.makeCanvas('folio-scene')
    this.liveCanvas = this.makeCanvas('folio-live')
    this.domLayer = document.createElement('div')
    this.domLayer.className = 'folio-dom'
    Object.assign(this.domLayer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' })
    this.root.append(this.sceneCanvas, this.liveCanvas, this.domLayer)
    container.appendChild(this.root)

    this.renderer = opts.rendererFactory
      ? opts.rendererFactory({ canvas: this.sceneCanvas, kind: opts.renderer, theme: this._theme })
      : createDefaultRenderer({ canvas: this.sceneCanvas, kind: opts.renderer, theme: this._theme })
    this.live = opts.liveLayerFactory ? opts.liveLayerFactory(this.liveCanvas) : createDefaultLiveLayer(this.liveCanvas)

    this.textEditor = new TextEditor(this)
    this.unsubDoc = this.document.subscribe((e) => this.onDocChange(e))
    this.rebuild()
    this.input = new InputController(this)
    this.measure()
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.measure())
      this.resizeObserver.observe(container)
    }
  }

  private makeCanvas(cls: string): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.className = cls
    Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' })
    this.root.appendChild(c)
    return c
  }

  // ---------------------------------------------------------------------------
  // basic state
  // ---------------------------------------------------------------------------

  get pageId(): PageId { return this._pageId }
  get page(): Page | undefined { return this.document.page(this._pageId) }
  get camera(): Readonly<Camera> { return this._camera }
  get tool(): Tool { return this._tool }
  get toolOptions(): Readonly<ToolOptionsMap> {
    if (!this._toolOptionsView) {
      this._toolOptionsView = { ...this._toolOptions, ...derivedToolOptions(this._itemStyle, this._toolOptions.shape.kind) }
    }
    return this._toolOptionsView
  }
  /** Style used for NEW shapes / arrows / text (shared, Excalidraw "current item" style). */
  get itemStyle(): Readonly<ItemStyle> { return this._itemStyle }
  get theme(): VisualTheme { return this._theme }
  get readOnly(): boolean { return this._readOnly }
  get penMode(): PenMode { return this._penMode }
  get viewportSize(): Readonly<Size> { return this.viewport }
  get zoom(): number { return this._camera.zoom }

  on<K extends keyof EditorEvents>(event: K, cb: (p: EditorEvents[K]) => void): () => void {
    return this.events.on(event, cb)
  }

  setReadOnly(v: boolean): void {
    this._readOnly = v
    if (v) this.commitTextEdit()
    this.requestRender()
  }

  setPenMode(m: PenMode): void { this._penMode = m }

  setTheme(theme: VisualTheme): void {
    this._theme = theme
    this.renderer.invalidate()
    this.requestRender()
  }

  setTool(tool: Tool): void {
    if (tool === this._tool) return
    this.commitTextEdit()
    this._tool = tool
    this.events.emit('tool', tool)
    this.emitStyle()
    this.requestRender()
  }

  setToolOptions<T extends Tool>(tool: T, patch: Partial<ToolOptionsMap[T]>): void {
    if (tool === 'shape' || tool === 'arrow' || tool === 'text') {
      // shape / arrow / text options are a view over the shared item style
      const p = patch as Record<string, unknown>
      if (tool === 'shape' && p.kind !== undefined) {
        this._toolOptions = { ...this._toolOptions, shape: { ...this._toolOptions.shape, kind: p.kind as ToolOptionsMap['shape']['kind'] } }
      }
      this.mergeItemStyle(itemPatchFromToolOptions(tool, p))
    } else {
      this._toolOptions = { ...this._toolOptions, [tool]: { ...this._toolOptions[tool], ...patch } }
    }
    this._toolOptionsView = undefined
    this.events.emit('tool', this._tool)
    this.emitStyle()
  }

  // ---------------------------------------------------------------------------
  // style (Excalidraw-like properties panel API)
  // ---------------------------------------------------------------------------

  private mergeItemStyle(patch: StylePatch): void {
    const next = { ...this._itemStyle }
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as Record<string, unknown>)[k] = v
    this._itemStyle = next
    this._toolOptionsView = undefined
  }

  /** Restore a persisted item style without touching the selection. */
  setItemStyle(style: Partial<ItemStyle>): void {
    this.mergeItemStyle(style)
    this.events.emit('tool', this._tool)
    this.emitStyle()
  }

  /** What the properties panel should show: the selection if any, else the active tool. */
  styleContext(): StyleContext {
    const bg = this.page?.background.color ?? '#ffffff'
    const leaves = this.leavesOfSelection().filter((o) => !o.supersededBy && applicableFor(o).length)
    if (leaves.length) return selectionContext(leaves, bg)
    return toolContext(this._tool, this._itemStyle, this._toolOptions, bg)
  }

  private emitStyle(): void {
    if (this.destroyed) return
    this.events.emit('style', this.styleContext())
  }

  /**
   * Apply a style patch. With a selection: restyles every applicable selected
   * object as ONE undo step (pass `coalesceKey` while a slider drags) and also
   * merges into itemStyle (like Excalidraw). Without a selection and with the
   * pen / highlighter active, updates that tool's options; otherwise updates
   * itemStyle for future shapes / arrows / text. Returns the number of objects changed.
   */
  setStyle(patch: StylePatch, o?: ExecuteOptions): number {
    const leaves = this.leavesOfSelection().filter((x) => !x.supersededBy)
    let changed = 0
    if (leaves.length && !this._readOnly) {
      const entries: ObjectPatchEntry[] = []
      for (const l of leaves) {
        const p = patchForObject(l, patch)
        if (p) entries.push({ id: l.id, patch: p })
      }
      this.updateObjects(entries, o)
      changed = entries.length
      this.mergeItemStyle(patch)
    } else if (!leaves.length && (this._tool === 'pen' || this._tool === 'highlighter')) {
      const t = this._tool
      const cur = this._toolOptions[t]
      const next = { ...cur }
      if (patch.strokeColor !== undefined) next.color = patch.strokeColor
      if (patch.strokeWidth !== undefined) next.width = strokeToInkWidth(t, patch.strokeWidth)
      if (patch.opacity !== undefined) next.opacity = patch.opacity
      this._toolOptions = { ...this._toolOptions, [t]: next }
      this._toolOptionsView = undefined
      this.events.emit('tool', this._tool)
    } else {
      this.mergeItemStyle(patch)
      this.events.emit('tool', this._tool)
    }
    this._toolOptionsView = undefined
    this.emitStyle()
    return changed
  }

  setPage(pageId: PageId): void {
    if (pageId === this._pageId) return
    this.commitTextEdit()
    this.flushPending()
    this._pageId = pageId
    this._selection = []
    this.clearInteractionState()
    this.rebuild()
    this.renderer.invalidate()
    this.needsInitialFit = true
    this.applyInitialCamera()
    this.events.emit('selection', [])
    this.emitStyle()
    this.events.emit('history', { canUndo: this.canUndo, canRedo: this.canRedo })
    this.events.emit('change', { origin: 'load', pageIds: new Set([pageId]), pagesChanged: false, metaChanged: false })
    this.requestRender()
  }

  // ---------------------------------------------------------------------------
  // camera
  // ---------------------------------------------------------------------------

  screenToWorld(p: Vec2): Vec2 { return s2w(this._camera, p) }
  worldToScreen(p: Vec2): Vec2 { return w2s(this._camera, p) }

  setCamera(c: Partial<Camera>): void {
    let next: Camera = {
      x: c.x ?? this._camera.x,
      y: c.y ?? this._camera.y,
      zoom: clampZoom(c.zoom ?? this._camera.zoom),
    }
    const page = this.page
    if (page?.kind === 'fixed' && page.width && page.height) {
      next = clampCameraToPage(next, { width: page.width, height: page.height }, this.viewport.width, this.viewport.height)
    }
    const cur = this._camera
    if (next.x === cur.x && next.y === cur.y && next.zoom === cur.zoom) return
    this._camera = next
    this.textEditor.reposition()
    this.events.emit('camera', next)
    this.requestRender()
  }

  /** Pan by a screen-space delta (content follows the finger). */
  panBy(dx: number, dy: number): void {
    this.setCamera({ x: this._camera.x - dx / this._camera.zoom, y: this._camera.y - dy / this._camera.zoom })
  }

  /** Zoom by `factor` keeping the world point under `screenPt` fixed. */
  zoomAt(screenPt: Vec2, factor: number): void {
    const c = zoomCameraAt(this._camera, screenPt, factor)
    this.setCamera(c)
  }

  zoomToRect(rect: Rect, padding = 48): void {
    this.setCamera(cameraForRect(rect, this.viewport.width, this.viewport.height, padding))
  }

  /** Fit the whole fixed page, or the content of an infinite page. */
  zoomToFit(): void {
    const page = this.page
    if (page?.kind === 'fixed' && page.width && page.height) {
      return this.zoomToRect({ x: 0, y: 0, width: page.width, height: page.height }, 24)
    }
    const rects: Rect[] = []
    for (const o of this.objs.values()) {
      if (o.supersededBy) continue
      const b = worldBounds(o, this.resolve)
      if (b) rects.push(b)
    }
    const u = unionRects(rects)
    if (u) this.zoomToRect(u, 48)
    else this.setCamera({ x: -this.viewport.width / 2, y: -this.viewport.height / 2, zoom: 1 })
  }

  /** Fixed pages: zoom so the page width fills the viewport. */
  fitWidth(padding = 16): void {
    const page = this.page
    if (!page?.width) return
    const zoom = clampZoom((this.viewport.width - padding * 2) / page.width)
    this.setCamera({ zoom, x: page.width / 2 - this.viewport.width / zoom / 2, y: -padding / zoom })
  }

  private applyInitialCamera(): void {
    if (this.viewport.width <= 0 || !this.needsInitialFit) return
    this.needsInitialFit = false
    const page = this.page
    if (page?.kind === 'fixed' && page.width) {
      this._camera = { x: 0, y: 0, zoom: 1 }
      this.fitWidth()
    } else {
      this.setCamera({ zoom: 1, x: -this.viewport.width / 2, y: -this.viewport.height / 2 })
    }
  }

  setHighlights(rects: Rect[] | undefined): void {
    this.highlights = rects && rects.length ? rects : undefined
    this.requestRender()
  }

  // ---------------------------------------------------------------------------
  // sizing
  // ---------------------------------------------------------------------------

  /** Re-measure the container (or use an explicit size). */
  measure(width?: number, height?: number, dpr?: number): void {
    const c = this.opts.container
    const w = Math.max(0, Math.round(width ?? c.clientWidth ?? 0))
    const h = Math.max(0, Math.round(height ?? c.clientHeight ?? 0))
    const d = dpr ?? (typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1)
    if (w === this.viewport.width && h === this.viewport.height && d === this.viewport.dpr) {
      this.applyInitialCamera()
      return
    }
    this.viewport = { width: w, height: h, dpr: d }
    for (const cv of [this.sceneCanvas, this.liveCanvas]) {
      cv.width = Math.max(1, Math.round(w * d))
      cv.height = Math.max(1, Math.round(h * d))
    }
    this.renderer.resize(this.viewport)
    this.live.resize(this.viewport)
    this.applyInitialCamera()
    this.textEditor.reposition()
    this.requestRender()
  }

  // ---------------------------------------------------------------------------
  // page cache + spatial index
  // ---------------------------------------------------------------------------

  /** Resolve an object of the current page (live-preview overrides win). */
  readonly resolve = (id: ObjectId): CanvasObject | undefined => this.overrides.get(id) ?? this.objs.get(id)

  private static indexable(o: CanvasObject): boolean {
    return o.type !== 'group' && !o.supersededBy
  }

  private rebuild(): void {
    this.objs.clear()
    this.arrowIds.clear()
    this.minZ = 0
    this.maxZ = 0
    let first = true
    for (const o of this.document.objects(this._pageId)) {
      this.objs.set(o.id, o)
      if (o.type === 'arrow') this.arrowIds.add(o.id)
      if (first) { this.minZ = this.maxZ = o.z; first = false }
      else { this.minZ = Math.min(this.minZ, o.z); this.maxZ = Math.max(this.maxZ, o.z) }
    }
    const entries: [ObjectId, Rect][] = []
    for (const o of this.objs.values()) {
      if (!Editor.indexable(o)) continue
      const b = worldBounds(o, this.resolve)
      if (b) entries.push([o.id, b])
    }
    this.index.load(entries)
  }

  /** Incrementally refresh cache + index for changed ids (and arrows bound to them). */
  private syncIds(ids: Iterable<ObjectId>): Set<ObjectId> {
    const changed = new Set<ObjectId>(ids)
    for (const id of changed) {
      const o = this.document.object(this._pageId, id)
      if (o) {
        this.objs.set(id, o)
        if (o.type === 'arrow') this.arrowIds.add(id)
        else this.arrowIds.delete(id)
        this.maxZ = Math.max(this.maxZ, o.z)
        this.minZ = Math.min(this.minZ, o.z)
      } else {
        this.objs.delete(id)
        this.arrowIds.delete(id)
      }
    }
    const reindex = new Set(changed)
    for (const aid of this.arrowIds) {
      if (reindex.has(aid)) continue
      const a = this.objs.get(aid) as ArrowObject
      if ((a.startBinding && changed.has(a.startBinding.objectId)) || (a.endBinding && changed.has(a.endBinding.objectId))) {
        reindex.add(aid)
      }
    }
    for (const id of reindex) {
      const o = this.objs.get(id)
      this.index.set(id, o && Editor.indexable(o) ? worldBounds(o, this.resolve) ?? null : null)
    }
    return reindex
  }

  private onDocChange(e: DocChangeEvent): void {
    if (this.destroyed) return
    if (!e.pageIds.has(this._pageId)) {
      if (e.pagesChanged) this.requestRender()
      return
    }
    if (e.origin === 'load' || !e.objectIds) {
      this.rebuild()
      this.renderer.invalidate()
    } else {
      const affected = this.syncIds(e.objectIds)
      this.renderer.invalidate(affected)
    }
    this.pruneSelection()
    this.events.emit('change', e)
    if (this._selection.length && (!e.objectIds || this.selectionTouchedBy(e.objectIds))) this.emitStyle()
    else if (e.pagesChanged) this.emitStyle()
    this.requestRender()
  }

  private selectionTouchedBy(ids: Iterable<ObjectId>): boolean {
    const sel = new Set<ObjectId>()
    for (const l of this.leavesOfSelection()) sel.add(l.id)
    for (const s of this._selection) sel.add(s)
    for (const id of ids) if (sel.has(id)) return true
    return false
  }

  /** Objects (not superseded, non-group) whose bounds intersect the world rect. */
  queryRect(r: Rect): CanvasObject[] {
    const out: CanvasObject[] = []
    for (const id of this.index.search(r)) {
      const o = this.objs.get(id)
      if (o && !o.supersededBy) out.push(o)
    }
    return out
  }

  /** Ids currently in the spatial index (tests / diagnostics). */
  indexedIds(): ObjectId[] { return this.index.all() }

  getObject(id: ObjectId): CanvasObject | undefined { return this.resolve(id) }

  allObjects(): CanvasObject[] { return [...this.objs.values()].sort((a, b) => a.z - b.z) }

  /** Topmost object hit at a world point (tolerance in screen px). */
  hitTest(p: Vec2, tolPx = 6): CanvasObject | undefined {
    const tol = tolPx / this._camera.zoom
    const cands = this.queryRect({ x: p.x - tol, y: p.y - tol, width: tol * 2, height: tol * 2 })
    cands.sort((a, b) => b.z - a.z)
    for (const o of cands) if (hitTestObject(this.resolve(o.id) ?? o, p, tol, this.resolve)) return o
    return undefined
  }

  objectsInRect(r: Rect): CanvasObject[] {
    return this.queryRect(r).filter((o) => {
      const b = worldBounds(this.resolve(o.id) ?? o, this.resolve)
      return !!b && rectsIntersect(b, r)
    })
  }

  objectsInLasso(poly: Vec2[]): CanvasObject[] {
    if (poly.length < 3) return []
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of poly) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    return this.queryRect({ x: minX, y: minY, width: maxX - minX, height: maxY - minY })
      .filter((o) => objectIntersectsLasso(o, poly, this.resolve))
  }

  /** Nearest object under/near a point that an arrow endpoint can bind to. */
  findBindingTarget(p: Vec2, exclude?: ReadonlySet<ObjectId>, tolPx = 12): CanvasObject | undefined {
    const tol = tolPx / this._camera.zoom
    const cands = this.queryRect({ x: p.x - tol, y: p.y - tol, width: tol * 2, height: tol * 2 })
      .filter((o) => (o.type === 'shape' || o.type === 'text' || o.type === 'image') && !exclude?.has(o.id))
      .sort((a, b) => b.z - a.z)
    for (const o of cands) {
      const lb = localBounds(o)
      if (!lb) continue
      const lp = worldToLocal(o.transform, p)
      const k = Math.max(1e-6, Math.sqrt(Math.abs(o.transform.scaleX * o.transform.scaleY)))
      const r = inflate(lb, tol / k)
      if (lp.x >= r.x && lp.x <= r.x + r.width && lp.y >= r.y && lp.y <= r.y + r.height) return o
    }
    return undefined
  }

  // ---------------------------------------------------------------------------
  // rendering
  // ---------------------------------------------------------------------------

  requestRender(): void {
    this.dirty = true
    if (this.rafId || this.destroyed) return
    this.rafId = raf(() => {
      this.rafId = 0
      if (this.dirty) this.renderNow()
    })
  }

  /** Render synchronously (used by the frame loop, and to flush before clearing the live layer). */
  renderNow(): void {
    if (this.destroyed) return
    this.dirty = false
    const page = this.page
    if (page && this.viewport.width > 0) {
      this.live.setBackground?.(page.background.color)
      this.renderer.render(this.buildScene(page), this._camera)
    }
    if (this.pendingLiveClear) {
      this.pendingLiveClear = false
      this.live.clear()
    }
  }

  private buildScene(page: Page): Scene {
    const cam = this._camera
    const vw = this.viewport.width / cam.zoom
    const vh = this.viewport.height / cam.zoom
    const margin = 32 / cam.zoom
    const ids = new Set(this.index.search({ x: cam.x - margin, y: cam.y - margin, width: vw + margin * 2, height: vh + margin * 2 }))
    for (const id of this.overrides.keys()) ids.add(id)
    const objects: CanvasObject[] = []
    for (const id of ids) {
      const o = this.resolve(id)
      if (o && !o.supersededBy && o.type !== 'group') objects.push(o)
    }
    objects.sort((a, b) => a.z - b.z)
    const hidden = new Set<ObjectId>(this.hiddenExtra)
    const editing = this.textEditor.editingId
    if (editing) hidden.add(editing)
    return {
      page,
      objects,
      resolve: this.resolve,
      selection: this.buildOverlay(),
      hiddenIds: hidden.size ? hidden : undefined,
      previews: this.previewObjects.length ? this.previewObjects : undefined,
      highlights: this.highlights,
      theme: this._theme,
    }
  }

  private buildOverlay(): SelectionOverlay | undefined {
    const { marquee, lasso, bindingTargetId } = this.overlayExtra
    if (!this._selection.length && !marquee && !lasso && !bindingTargetId) return undefined
    const frame = this.selectionFrame()
    const onlyArrow = this.leavesOfSelection().length === 1 && this.leavesOfSelection()[0].type === 'arrow'
    const arrowHandles = !this._readOnly && this._tool === 'select' && !this.hideHandles && !this.textEditor.editingId
      ? this.selectedArrowHandles() : undefined
    return {
      ids: this._selection,
      bounds: frame?.rect,
      rotation: frame?.rotation,
      showHandles: !!frame && !this._readOnly && this._tool === 'select' && !onlyArrow && !this.hideHandles && !this.textEditor.editingId,
      marquee,
      lasso,
      bindingTargetId,
      arrowHandles,
    }
  }

  /** The single selected arrow, if the selection is exactly one arrow. */
  selectedArrow(): ArrowObject | undefined {
    const leaves = this.leavesOfSelection()
    return leaves.length === 1 && leaves[0].type === 'arrow' ? leaves[0] : undefined
  }

  /** Editing handles (ends, waypoints, virtual mid-segment handles) of the single selected arrow. */
  selectedArrowHandles(): ArrowHandleSpec[] | undefined {
    const a = this.selectedArrow()
    return a ? arrowHandleSpecs(a, this.resolve) : undefined
  }

  // -- interaction state (used by the input controller) ---------------------------

  /** Show patched copies of objects without committing (drag/resize/rotate preview). */
  setPreview(entries: ObjectPatchEntry[] | null): void {
    const old = [...this.overrides.keys()]
    this.overrides.clear()
    if (entries) {
      for (const { id, patch } of entries) {
        const o = this.objs.get(id)
        if (o) this.overrides.set(id, applyPatch(o, patch))
      }
    }
    this.renderer.invalidate([...old, ...this.overrides.keys()])
    this.requestRender()
  }

  setPreviewObjects(objs: CanvasObject[]): void {
    this.previewObjects = objs
    this.requestRender()
  }

  setHiddenIds(ids: Iterable<ObjectId>): void {
    this.hiddenExtra = new Set(ids)
    this.requestRender()
  }

  setOverlayExtra(x: Pick<SelectionOverlay, 'marquee' | 'lasso' | 'bindingTargetId'>): void {
    this.overlayExtra = x
    this.requestRender()
  }

  setHandlesHidden(v: boolean): void {
    this.hideHandles = v
    this.requestRender()
  }

  clearInteractionState(): void {
    this.setPreview(null)
    this.previewObjects = []
    this.hiddenExtra = new Set()
    this.overlayExtra = {}
    this.hideHandles = false
    this.requestRender()
  }

  // ---------------------------------------------------------------------------
  // live ink + deferred stroke commit
  // ---------------------------------------------------------------------------

  /** Allocate a z above everything on the page. */
  nextZ(): number { return this.maxZ + 1 }

  /**
   * Commit a finished stroke AFTER the frame that shows it: the live layer keeps
   * displaying it until the retained scene has rendered the committed object.
   */
  commitStrokeDeferred(stroke: InkStroke): void {
    this.flushPending()
    this.pendingStroke = { pageId: this._pageId, stroke }
    this.pendingTimer = setTimeout(() => this.flushPending(), 0)
  }

  /** Commit a pending stroke and make sure it has been rendered (before a new live stroke starts). */
  settleLive(): void {
    this.flushPending()
    if (this.pendingLiveClear) this.renderNow()
  }

  /** Commit any deferred stroke right now. */
  flushPending(): void {
    if (this.pendingTimer !== undefined) clearTimeout(this.pendingTimer)
    this.pendingTimer = undefined
    const p = this.pendingStroke
    if (!p) return
    this.pendingStroke = undefined
    this.maxZ = Math.max(this.maxZ, p.stroke.z)
    this.execute([{ type: 'addObjects', pageId: p.pageId, objects: [p.stroke] }])
    this.pendingLiveClear = true
    this.requestRender()
    this.opts.onStrokeCommitted?.(p.pageId, p.stroke)
  }

  // ---------------------------------------------------------------------------
  // commands & history
  // ---------------------------------------------------------------------------

  private history(): PageHistory {
    let h = this.histories.get(this._pageId)
    if (!h) this.histories.set(this._pageId, (h = { undo: [], redo: [] }))
    return h
  }

  get canUndo(): boolean { return this.history().undo.length > 0 }
  get canRedo(): boolean { return this.history().redo.length > 0 }
  private emitHistory(): void {
    this.events.emit('history', { canUndo: this.canUndo, canRedo: this.canRedo })
  }

  /** Apply operations as a local commit; records an undo step unless `undoable: false`. */
  execute(ops: Operation[], o: ExecuteOptions = {}): void {
    if (!ops.length || this._readOnly) return
    const undoable = o.undoable !== false
    const inverse = undoable ? this.document.inverse(ops) : []
    this.document.apply(ops, 'local')
    if (undoable) {
      const h = this.history()
      const last = h.undo[h.undo.length - 1]
      const now = Date.now()
      if (o.coalesceKey && last && last.key === o.coalesceKey && now - last.time < COALESCE_WINDOW_MS) {
        last.ops = [...last.ops, ...ops]
        last.inverse = [...inverse, ...last.inverse]
        last.time = now
      } else {
        h.undo.push({ ops, inverse, key: o.coalesceKey, time: now })
        if (h.undo.length > HISTORY_LIMIT) h.undo.shift()
      }
      h.redo.length = 0
      this.emitHistory()
    }
    this.opts.onOperations?.(ops)
  }

  /** Drop parts of `ops` whose targets vanished (e.g. deleted remotely) or already exist. */
  private sanitize(ops: Operation[]): Operation[] {
    const out: Operation[] = []
    for (const op of ops) {
      if (op.type === 'addObjects') {
        const objects = op.objects.filter((o) => !this.document.object(op.pageId, o.id))
        if (objects.length) out.push({ ...op, objects })
      } else if (op.type === 'deleteObjects') {
        const ids = op.ids.filter((id) => !!this.document.object(op.pageId, id))
        if (ids.length) out.push({ ...op, ids })
      } else if (op.type === 'updateObjects') {
        const patches = op.patches.filter((p) => !!this.document.object(op.pageId, p.id))
        if (patches.length) out.push({ ...op, patches })
      } else out.push(op)
    }
    return out
  }

  undo(): boolean {
    if (this._readOnly) return false
    this.flushPending()
    this.commitTextEdit()
    const h = this.history()
    const entry = h.undo.pop()
    if (!entry) return false
    const ops = this.sanitize(entry.inverse)
    if (ops.length) {
      this.document.apply(ops, 'local')
      this.opts.onOperations?.(ops)
    }
    h.redo.push(entry)
    this.emitHistory()
    return true
  }

  redo(): boolean {
    if (this._readOnly) return false
    this.flushPending()
    this.commitTextEdit()
    const h = this.history()
    const entry = h.redo.pop()
    if (!entry) return false
    const ops = this.sanitize(entry.ops)
    if (ops.length) {
      this.document.apply(ops, 'local')
      this.opts.onOperations?.(ops)
    }
    h.undo.push(entry)
    this.emitHistory()
    return true
  }

  clearHistory(): void {
    this.histories.clear()
    this.emitHistory()
  }

  // ---------------------------------------------------------------------------
  // selection
  // ---------------------------------------------------------------------------

  get selection(): readonly ObjectId[] { return this._selection }

  /** Root group id of an object (or the object itself). */
  topGroupOf(id: ObjectId): ObjectId {
    let cur = id
    for (let i = 0; i < 32; i++) {
      const o = this.objs.get(cur)
      if (!o?.groupId || !this.objs.has(o.groupId)) return cur
      cur = o.groupId
    }
    return cur
  }

  /** Non-group leaf objects covered by ids (groups expand recursively). */
  leavesOf(ids: Iterable<ObjectId>): CanvasObject[] {
    const out = new Map<ObjectId, CanvasObject>()
    const visit = (id: ObjectId, depth: number): void => {
      const o = this.resolve(id)
      if (!o || depth > 32) return
      if (o.type === 'group') for (const c of o.childIds) visit(c, depth + 1)
      else out.set(o.id, o)
    }
    for (const id of ids) visit(id, 0)
    return [...out.values()]
  }

  /** Leaves plus every group object nested within ids (for deletion / copy). */
  private descendantsOf(ids: Iterable<ObjectId>): CanvasObject[] {
    const out = new Map<ObjectId, CanvasObject>()
    const visit = (id: ObjectId, depth: number): void => {
      const o = this.objs.get(id)
      if (!o || depth > 32) return
      out.set(o.id, o)
      if (o.type === 'group') for (const c of o.childIds) visit(c, depth + 1)
    }
    for (const id of ids) visit(id, 0)
    return [...out.values()]
  }

  private leavesOfSelection(): CanvasObject[] { return this.leavesOf(this._selection) }

  /** Select objects (members of groups select their whole top-level group). */
  select(ids: Iterable<ObjectId>): void {
    const set = new Set<ObjectId>()
    for (const id of ids) {
      const o = this.objs.get(id)
      if (!o || o.supersededBy) continue
      set.add(this.topGroupOf(id))
    }
    const next = [...set]
    if (next.length === this._selection.length && next.every((v, i) => v === this._selection[i])) return
    this._selection = next
    this.events.emit('selection', next)
    this.emitStyle()
    this.requestRender()
  }

  clearSelection(): void { this.select([]) }

  selectAll(): void {
    this.select([...this.objs.values()].filter((o) => !o.supersededBy && o.type !== 'group').map((o) => o.id))
  }

  private pruneSelection(): void {
    const keep = this._selection.filter((id) => {
      const o = this.objs.get(id)
      return !!o && !o.supersededBy
    })
    if (keep.length !== this._selection.length) {
      this._selection = keep
      this.events.emit('selection', keep)
      this.emitStyle()
    }
  }

  /** Oriented frame of the current selection (uses live preview geometry). */
  selectionFrame(): SelectionFrame | undefined {
    return computeFrame(this.leavesOfSelection(), this.resolve)
  }

  /** Axis-aligned world bounds of the selection. */
  selectionBounds(): Rect | undefined {
    const rects: Rect[] = []
    for (const o of this.leavesOfSelection()) {
      const b = worldBounds(o, this.resolve)
      if (b) rects.push(b)
    }
    return unionRects(rects)
  }

  /** Handle ids in a fixed order (for renderers/tests). */
  static readonly HANDLES = HANDLE_IDS

  // ---------------------------------------------------------------------------
  // object commands
  // ---------------------------------------------------------------------------

  /** Ops deleting `ids`; arrows bound to them are detached in place first. */
  buildDeleteOps(ids: Iterable<ObjectId>): Operation[] {
    const del = new Set<ObjectId>()
    for (const id of ids) if (this.objs.has(id)) del.add(id)
    if (!del.size) return []
    const patches: { id: ObjectId; patch: ObjectPatch }[] = []
    for (const aid of this.arrowIds) {
      if (del.has(aid)) continue
      const a = this.objs.get(aid) as ArrowObject
      const sb = !!a.startBinding && del.has(a.startBinding.objectId)
      const eb = !!a.endBinding && del.has(a.endBinding.objectId)
      if (!sb && !eb) continue
      const r = resolveArrowEndpoints(a, this.resolve)
      const patch: ObjectPatch = { updatedAt: Date.now(), $unset: [] }
      if (sb) { patch.start = r.start; patch.$unset!.push('startBinding') }
      if (eb) { patch.end = r.end; patch.$unset!.push('endBinding') }
      patches.push({ id: aid, patch })
    }
    const ops: Operation[] = []
    if (patches.length) ops.push({ type: 'updateObjects', pageId: this._pageId, patches })
    ops.push({ type: 'deleteObjects', pageId: this._pageId, ids: [...del] })
    return ops
  }

  deleteObjects(ids: Iterable<ObjectId>): void {
    this.execute(this.buildDeleteOps(ids))
  }

  deleteSelection(): void {
    if (!this._selection.length) return
    const ids = this.descendantsOf(this._selection).map((o) => o.id)
    this.clearSelection()
    this.deleteObjects(ids)
  }

  /** Update objects with a patch each, stamped with updatedAt. */
  updateObjects(entries: ObjectPatchEntry[], o?: ExecuteOptions): void {
    if (!entries.length) return
    const now = Date.now()
    this.execute(
      [{ type: 'updateObjects', pageId: this._pageId, patches: entries.map((e) => ({ id: e.id, patch: { updatedAt: now, ...e.patch } })) }],
      o,
    )
  }

  /**
   * Apply colour / width / opacity to every selected leaf as ONE undoable commit.
   * ink: style.color/width/opacity; shape & arrow: style.strokeColor/strokeWidth/opacity;
   * text: color (width and opacity do not apply). Pass `{coalesceKey}` while a slider is dragged so
   * the drag is one undo step. Returns the number of objects changed.
   */
  setSelectionStyle(patch: SelectionStylePatch, o?: ExecuteOptions): number {
    if (this.readOnly) return 0
    const sp: StylePatch = {}
    if (patch.color !== undefined) sp.strokeColor = patch.color
    if (patch.width !== undefined) sp.strokeWidth = patch.width
    if (patch.opacity !== undefined) sp.opacity = patch.opacity
    const entries: ObjectPatchEntry[] = []
    for (const l of this.leavesOfSelection()) {
      if (l.supersededBy) continue
      // legacy semantics: ink width is the raw world width; text has no width
      const p = patchForObject(l, l.type === 'text' ? { ...sp, strokeWidth: undefined } : sp, true)
      if (p) entries.push({ id: l.id, patch: p })
    }
    this.updateObjects(entries, o)
    return entries.length
  }

  addObjects(objects: CanvasObject[]): void {
    if (!objects.length) return
    this.execute([{ type: 'addObjects', pageId: this._pageId, objects }])
  }

  /** Copy the selection (leaves + nested groups) into a serialisable payload. */
  copySelection(): ClipboardPayload | undefined {
    if (!this._selection.length) return undefined
    const objects = this.descendantsOf(this._selection).map((o) => JSON.parse(JSON.stringify(o)) as CanvasObject)
    const payload: ClipboardPayload = { kind: 'folio-clipboard', version: 1, objects }
    internalClipboard = payload
    this.pasteSerial = 0
    const text = objects.filter((o): o is TextObject => o.type === 'text').map((o) => o.text).join('\n')
    try {
      if (text) void navigator.clipboard?.writeText(text).catch(() => {})
    } catch { /* clipboard unavailable */ }
    return payload
  }

  /** Paste a payload (default: internal clipboard). `at` = world point for the payload's center. */
  paste(payload?: ClipboardPayload, at?: Vec2): ObjectId[] {
    const p = payload ?? internalClipboard
    if (!p || !p.objects.length || this._readOnly) return []
    let dx = 20
    let dy = 20
    if (at) {
      const frame = computeFrame(
        p.objects.filter((o) => o.type !== 'group'),
        (id) => p.objects.find((o) => o.id === id),
      )
      if (frame) { dx = at.x - frame.center.x; dy = at.y - frame.center.y }
    } else if (payload === undefined) {
      this.pasteSerial++
      dx = dy = 20 * this.pasteSerial
    }
    return this.insertClones(p.objects, dx, dy)
  }

  get pasteAvailable(): boolean { return !!internalClipboard }

  /** Paste plain text (e.g. from the system clipboard) as a text object at the viewport center. */
  pasteText(text: string): ObjectId | undefined {
    if (this._readOnly || !text.trim()) return undefined
    const t = this._itemStyle
    const c = this.screenToWorld({ x: this.viewport.width / 2, y: this.viewport.height / 2 })
    const now = Date.now()
    const obj: TextObject = {
      id: createId(), type: 'text', transform: { x: c.x, y: c.y, rotation: 0, scaleX: 1, scaleY: 1 }, z: this.nextZ(),
      createdAt: now, updatedAt: now, text, fontSize: t.fontSize, fontFamily: t.fontFamily, color: t.strokeColor,
      align: t.textAlign, opacity: t.opacity,
    }
    this.addObjects([obj])
    this.select([obj.id])
    return obj.id
  }

  duplicateSelection(): ObjectId[] {
    if (!this._selection.length) return []
    const objects = this.descendantsOf(this._selection)
    return this.insertClones(objects, 20, 20)
  }

  private insertClones(objects: CanvasObject[], dx: number, dy: number): ObjectId[] {
    const { objects: clones } = cloneObjects(objects, dx, dy, this.maxZ)
    this.execute([{ type: 'addObjects', pageId: this._pageId, objects: clones }])
    const top = clones.filter((c) => !c.groupId).map((c) => c.id)
    this.select(top)
    return top
  }

  groupSelection(): ObjectId | undefined {
    if (this._selection.length < 2) return undefined
    const members = this._selection.map((id) => this.objs.get(id)!).filter(Boolean)
    const now = Date.now()
    const group: GroupObject = {
      id: createId(), type: 'group', transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      z: Math.max(...members.map((m) => m.z)), createdAt: now, updatedAt: now, childIds: members.map((m) => m.id),
    }
    this.execute([
      { type: 'addObjects', pageId: this._pageId, objects: [group] },
      { type: 'updateObjects', pageId: this._pageId, patches: members.map((m) => ({ id: m.id, patch: { groupId: group.id, updatedAt: now } })) },
    ])
    this.select([group.id])
    return group.id
  }

  ungroupSelection(): void {
    const groups = this._selection.map((id) => this.objs.get(id)).filter((o): o is GroupObject => o?.type === 'group')
    if (!groups.length) return
    const now = Date.now()
    const children: ObjectId[] = []
    const patches: { id: ObjectId; patch: ObjectPatch }[] = []
    for (const g of groups) {
      for (const c of g.childIds) {
        if (!this.objs.has(c)) continue
        children.push(c)
        patches.push({ id: c, patch: { updatedAt: now, $unset: ['groupId'] } })
      }
    }
    this.clearSelection()
    this.execute([
      { type: 'updateObjects', pageId: this._pageId, patches },
      { type: 'deleteObjects', pageId: this._pageId, ids: groups.map((g) => g.id) },
    ])
    this.select(children)
  }

  bringToFront(): void {
    const leaves = this.leavesOfSelection().sort((a, b) => a.z - b.z)
    this.updateObjects(leaves.map((o, i) => ({ id: o.id, patch: { z: this.maxZ + 1 + i } })))
  }

  sendToBack(): void {
    const leaves = this.leavesOfSelection().sort((a, b) => a.z - b.z)
    const base = this.minZ - leaves.length
    this.updateObjects(leaves.map((o, i) => ({ id: o.id, patch: { z: base + i } })))
  }

  /** Move the selection one step up in z-order (past the next unselected object). */
  bringForward(): void { this.stepZ(1) }
  /** Move the selection one step down in z-order. */
  sendBackward(): void { this.stepZ(-1) }

  private stepZ(dir: 1 | -1): void {
    const sel = new Set(this.leavesOfSelection().map((o) => o.id))
    if (!sel.size) return
    const list = [...this.objs.values()].filter((o) => o.type !== 'group' && !o.supersededBy).sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1))
    const zs = list.map((o) => o.z)
    // make z values distinct so swaps are meaningful
    for (let i = 1; i < zs.length; i++) if (zs[i] <= zs[i - 1]) zs[i] = zs[i - 1] + 1e-6
    const order = list.map((o) => o.id)
    if (dir > 0) {
      for (let i = order.length - 2; i >= 0; i--) {
        if (sel.has(order[i]) && !sel.has(order[i + 1])) [order[i], order[i + 1]] = [order[i + 1], order[i]]
      }
    } else {
      for (let i = 1; i < order.length; i++) {
        if (sel.has(order[i]) && !sel.has(order[i - 1])) [order[i], order[i - 1]] = [order[i - 1], order[i]]
      }
    }
    const entries: ObjectPatchEntry[] = []
    order.forEach((id, i) => {
      const o = this.objs.get(id)!
      if (o.z !== zs[i]) entries.push({ id, patch: { z: zs[i] } })
    })
    this.updateObjects(entries)
  }

  /** Nudge the selection (screen-independent world units); consecutive nudges coalesce. */
  nudgeSelection(dx: number, dy: number): void {
    const leaves = this.leavesOfSelection()
    if (!leaves.length) return
    this.updateObjects(computeMovePatches(leaves, dx, dy, this.resolve), { coalesceKey: 'nudge' })
  }

  // ---------------------------------------------------------------------------
  // Clean Up (non-destructive)
  // ---------------------------------------------------------------------------

  /** Create derived objects and mark their source strokes superseded — one undo step. */
  applyCleanup(plans: CleanupPlan[]): ObjectId[] {
    const now = Date.now()
    const created: CanvasObject[] = []
    const superseded: { id: ObjectId; patch: ObjectPatch }[] = []
    const claimed = new Set<ObjectId>()
    let z = this.maxZ
    for (const plan of plans) {
      const sources = plan.sourceStrokeIds.filter((id) => {
        const o = this.objs.get(id)
        return o?.type === 'ink' && !o.supersededBy && !claimed.has(id)
      })
      if (!sources.length) continue
      const id = createId()
      const base = {
        id, z: ++z, createdAt: now, updatedAt: now,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      }
      const obj = this.buildDerived(plan, base, sources)
      if (!obj) continue
      created.push(obj)
      for (const s of sources) {
        claimed.add(s)
        superseded.push({ id: s, patch: { supersededBy: id, updatedAt: now } })
      }
    }
    if (!created.length) return []
    // bind arrow endpoints to nearby objects (never to the strokes being replaced)
    for (const o of created) if (o.type === 'arrow') this.bindArrowEnds(o, claimed)
    this.execute([
      { type: 'addObjects', pageId: this._pageId, objects: created },
      { type: 'updateObjects', pageId: this._pageId, patches: superseded },
    ])
    return created.map((o) => o.id)
  }

  private buildDerived(plan: CleanupPlan, base: Pick<CanvasObject, 'id' | 'z' | 'createdAt' | 'updatedAt' | 'transform'>, sources: ObjectId[]): CanvasObject | undefined {
    const raw = JSON.parse(JSON.stringify(plan.object)) as Record<string, unknown>
    const t = this.toolOptions
    switch (plan.kind) {
      case 'text':
        return {
          text: '', fontSize: t.text.fontSize, fontFamily: t.text.fontFamily, color: t.text.color,
          sourceStrokeIds: sources, ...raw, ...base, transform: (raw.transform as TextObject['transform']) ?? base.transform, type: 'text',
        } as TextObject
      case 'shape':
        return {
          kind: 'rectangle', width: 100, height: 100, style: this.shapeStyle(), sourceStrokeIds: sources,
          ...raw, ...base, transform: (raw.transform as ShapeObject['transform']) ?? base.transform, type: 'shape',
        } as ShapeObject
      case 'arrow':
        return {
          start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, style: this.arrowStyle(), startHead: 'none', endHead: 'arrow',
          sourceStrokeIds: sources, ...raw, ...base, type: 'arrow',
        } as ArrowObject
    }
  }

  /** ShapeStyle for a NEW shape built from itemStyle (fill = backgroundColor, 'transparent' = none). */
  shapeStyle(seed?: number): ShapeObject['style'] {
    const s = this._itemStyle
    const style: ShapeObject['style'] = {
      strokeColor: s.strokeColor, strokeWidth: s.strokeWidth, opacity: s.opacity, roughness: s.roughness,
      fillStyle: s.fillStyle, strokeStyle: s.strokeStyle, seed: seed ?? Math.floor(Math.random() * 2 ** 31),
    }
    if (s.backgroundColor && s.backgroundColor !== 'transparent') style.fillColor = s.backgroundColor
    return style
  }

  /** ShapeStyle for a NEW arrow (no fill). */
  arrowStyle(seed?: number): ShapeObject['style'] {
    const { fillColor: _f, fillStyle: _fs, ...rest } = this.shapeStyle(seed)
    return rest
  }

  /** Resolved (binding-aware) endpoints of an arrow. */
  arrowEnds(a: ArrowObject): { start: Vec2; end: Vec2 } {
    return resolveArrowEndpoints(a, this.resolve)
  }

  /** Bind unbound arrow ends to objects within tolerance of the endpoint. */
  private bindArrowEnds(a: ArrowObject, exclude: ReadonlySet<ObjectId>): void {
    const tolPx = 20 * this._camera.zoom
    if (!a.startBinding) {
      const t = this.findBindingTarget(a.start, exclude, tolPx)
      if (t) a.startBinding = { objectId: t.id }
    }
    if (!a.endBinding) {
      const t = this.findBindingTarget(a.end, exclude, tolPx)
      if (t && t.id !== a.startBinding?.objectId) a.endBinding = { objectId: t.id }
    }
  }

  /**
   * Reverse a cleanup. `ids` may be derived objects or their (superseded) source
   * strokes. Deletes the derived objects and un-supersedes the strokes.
   */
  restoreInk(ids: Iterable<ObjectId>): void {
    const derived = new Set<ObjectId>()
    for (const id of ids) {
      const o = this.objs.get(id)
      if (!o) continue
      if (o.supersededBy && this.objs.has(o.supersededBy)) derived.add(o.supersededBy)
      else if ('sourceStrokeIds' in o && o.sourceStrokeIds?.length) derived.add(o.id)
    }
    if (!derived.size) return
    const strokes = new Map<ObjectId, ObjectPatch>()
    const now = Date.now()
    for (const o of this.objs.values()) {
      if (o.supersededBy && derived.has(o.supersededBy)) strokes.set(o.id, { updatedAt: now, $unset: ['supersededBy'] })
    }
    const ops: Operation[] = []
    if (strokes.size) ops.push({ type: 'updateObjects', pageId: this._pageId, patches: [...strokes].map(([id, patch]) => ({ id, patch })) })
    // detach arrows bound to the derived objects before deleting them
    ops.push(...this.buildDeleteOps(derived))
    this.select([])
    this.execute(ops)
  }

  // ---------------------------------------------------------------------------
  // text editing
  // ---------------------------------------------------------------------------

  get editingId(): ObjectId | undefined { return this.textEditor.editingId }
  get isEditingText(): boolean { return this.textEditor.active }

  /** Create a new text object at a world point and open the editor. */
  startTextAt(p: Vec2): void { this.textEditor.startNew(p) }
  /** Edit a text object's content, or a shape/arrow label. */
  startTextEdit(id: ObjectId): boolean { return this.textEditor.startExisting(id) }
  commitTextEdit(): void { this.textEditor.commit() }

  // ---------------------------------------------------------------------------
  // export
  // ---------------------------------------------------------------------------

  async exportImage(o: ExportImageOptions = {}): Promise<Blob> {
    const pageId = o.pageId ?? this._pageId
    return exportPageImage(this.document, pageId, { scale: o.scale ?? 1, bounds: o.bounds, theme: this._theme })
  }

  /** PNG data URL whose longer side is at most `maxSize` px. */
  async thumbnail(maxSize = 256, pageId?: PageId): Promise<string> {
    const pid = pageId ?? this._pageId
    const page = this.document.page(pid)
    const w = page?.width ?? 1000
    const h = page?.height ?? 1000
    const blob = await this.exportImage({ pageId: pid, scale: Math.min(1, maxSize / Math.max(w, h)) })
    return blobToDataUrl(blob)
  }

  // ---------------------------------------------------------------------------

  destroy(): void {
    if (this.destroyed) return
    this.commitTextEdit()
    this.flushPending()
    this.textEditor.destroy()
    this.destroyed = true
    if (this.rafId) caf(this.rafId)
    this.unsubDoc()
    this.input.destroy()
    this.resizeObserver?.disconnect()
    this.renderer.dispose()
    this.live.dispose()
    this.events.clear()
    this.root.remove()
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

export function createEditor(opts: EditorOptions): Editor {
  return new Editor(opts)
}

export { MAX_ZOOM, MIN_ZOOM }

function sameStyle(a: object, b: object): boolean {
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  return Object.keys(x).every((k) => x[k] === y[k])
}
