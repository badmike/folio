/**
 * Pointer / wheel / keyboard input for the editor.
 *
 * Hot path: pointerdown → LiveStroke → pointermove (coalesced) → live layer,
 * pointerup → build InkStroke → commit AFTER the frame. Nothing in here runs
 * recognition, persistence or sync.
 */
import type { ArrowObject, CanvasObject, InkPoint, ObjectId, ObjectPatch, ShapeObject, Vec2 } from '@folio/document'
import { ROTATE_HANDLE_OFFSET, arrowPath, elbowWaypointsAfterDrag } from '@folio/renderer'
import { buildArrow, buildShape, shapeGeometry, snapAngle } from './create'
import type { Editor } from './editor'
import { createId, rectFromPoints, segmentTouchesObject } from './geometry'
import { buildInkStroke } from './ink'
import {
  HANDLE_IDS, computeMovePatches, computeRotatePatches, computeScalePatches, handlePosition, rotationHandlePosition,
  scaleFromHandle,
} from './manipulate'
import type { HandleId, ObjectPatchEntry, SelectionFrame } from './manipulate'

/** One pointer sample; a single instance is reused (no per-move allocation). */
interface Sample {
  x: number // screen, relative to the editor root
  y: number
  wx: number // world
  wy: number
  pressure: number
  tiltX: number
  tiltY: number
  time: number
  shift: boolean
  alt: boolean
  pointerType: 'pen' | 'touch' | 'mouse'
}

interface Interaction {
  pointerId: number
  move(s: Sample): void
  /** Called once after a batch of coalesced samples. */
  flush?(): void
  up(s: Sample): void
  cancel(): void
}

const TAP_MAX_MOVE = 6
const DOUBLE_TAP_MS = 350
const DOUBLE_TAP_DIST = 24

export class InputController {
  private el: HTMLElement
  private sample: Sample = {
    x: 0, y: 0, wx: 0, wy: 0, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, shift: false, alt: false, pointerType: 'mouse',
  }
  private rect = { left: 0, top: 0 }
  private interaction?: Interaction
  private touches = new Map<number, { x: number; y: number }>()
  private ignored = new Set<number>()
  private penSeen = false
  private penDown = 0
  private spaceDown = false
  private pointerInside = false
  private lastTap?: { t: number; x: number; y: number }
  private disposers: (() => void)[] = []

  constructor(private ed: Editor) {
    this.el = ed.root
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, o)
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, o))
    }
    on(this.el, 'pointerdown', (e) => this.onPointerDown(e))
    on(this.el, 'pointermove', (e) => this.onPointerMove(e))
    on(this.el, 'pointerup', (e) => this.onPointerUp(e, false))
    on(this.el, 'pointercancel', (e) => this.onPointerUp(e, true))
    on(this.el, 'wheel', (e) => this.onWheel(e), { passive: false })
    on(this.el, 'contextmenu', (e) => e.preventDefault())
    const win = (type: string, fn: (e: never) => void, capture = false) => {
      window.addEventListener(type, fn as EventListener, capture)
      this.disposers.push(() => window.removeEventListener(type, fn as EventListener, capture))
    }
    win('keydown', (e: KeyboardEvent) => this.onKeyDown(e))
    win('keyup', (e: KeyboardEvent) => this.onKeyUp(e))
    win('pointerdown', (e: PointerEvent) => {
      this.pointerInside = e.target instanceof Node && ed.opts.container.contains(e.target)
    }, true)
  }

  destroy(): void {
    this.interaction?.cancel()
    this.interaction = undefined
    for (const d of this.disposers) d()
    this.disposers = []
  }

  // -- helpers -----------------------------------------------------------------

  private fill(e: PointerEvent): Sample {
    const s = this.sample
    s.x = e.clientX - this.rect.left
    s.y = e.clientY - this.rect.top
    const cam = this.ed.camera
    s.wx = s.x / cam.zoom + cam.x
    s.wy = s.y / cam.zoom + cam.y
    const type = e.pointerType === 'pen' || e.pointerType === 'touch' ? e.pointerType : 'mouse'
    s.pointerType = type
    s.pressure = type === 'mouse' ? 0.5 : e.pressure || 0.5
    s.tiltX = e.tiltX || 0
    s.tiltY = e.tiltY || 0
    s.time = e.timeStamp
    s.shift = !!e.shiftKey
    s.alt = !!e.altKey
    return s
  }

  private touchDraws(): boolean {
    const m = this.ed.penMode
    return m === 'any' || (m === 'auto' && !this.penSeen)
  }

  // -- pointer events ---------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    const ed = this.ed
    this.pointerInside = true
    const r = this.el.getBoundingClientRect()
    this.rect.left = r.left
    this.rect.top = r.top
    const type = e.pointerType === 'pen' || e.pointerType === 'touch' ? e.pointerType : 'mouse'

    if (type === 'pen') {
      this.penSeen = true
      this.penDown++
    }
    // palm rejection: no touches while the pen is down
    if (type === 'touch' && this.penDown > 0) {
      this.ignored.add(e.pointerId)
      return
    }
    // a pointerdown outside the text overlay finishes text editing and is otherwise swallowed
    if (ed.isEditingText) {
      ed.commitTextEdit()
      this.ignored.add(e.pointerId)
      return
    }
    try { this.el.setPointerCapture(e.pointerId) } catch { /* not supported / synthetic */ }
    if (e.cancelable) e.preventDefault()
    try { ed.opts.container.focus({ preventScroll: true }) } catch { /* ignore */ }

    if (this.interaction && type !== 'touch') {
      // a new primary pointer replaces a stale interaction
      this.interaction.cancel()
      this.interaction = undefined
    }
    const s = this.fill(e)

    if (type === 'touch') {
      this.touches.set(e.pointerId, { x: s.x, y: s.y })
      if (this.touches.size >= 2) {
        // second finger: abandon any single-finger drawing/tool and switch to pinch/pan
        if (this.interaction) { this.interaction.cancel(); this.interaction = undefined }
        return
      }
      if (!(this.touchDraws() && !ed.readOnly)) return // one-finger pan handled in move
    }

    if (type === 'mouse') {
      if (e.button === 2) { this.ignored.add(e.pointerId); return }
      if (e.button === 1 || this.spaceDown || ed.readOnly) {
        this.interaction = new PanInteraction(ed, e.pointerId, s)
        return
      }
      if (e.button !== 0) return
    }
    if (ed.readOnly) return
    this.interaction = this.createToolInteraction(e.pointerId, s)
  }

  private createToolInteraction(id: number, s: Sample): Interaction | undefined {
    const ed = this.ed
    switch (ed.tool) {
      case 'pen':
      case 'highlighter':
        ed.settleLive()
        return new StrokeInteraction(ed, id, s, ed.tool)
      case 'eraser': return new EraserInteraction(ed, id, s)
      case 'select': return new SelectInteraction(ed, id, s, (t, hit) => this.onTap(t, hit))
      case 'shape': return new ShapeInteraction(ed, id, s)
      case 'arrow': return new ArrowInteraction(ed, id, s)
      case 'text': return new TextTapInteraction(ed, id, s)
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.ignored.has(e.pointerId)) return
    const t = this.touches.get(e.pointerId)
    if (t && !(this.interaction && this.interaction.pointerId === e.pointerId)) {
      this.gestureMove(e, t)
      return
    }
    const it = this.interaction
    if (!it || it.pointerId !== e.pointerId) return
    if (t) { // keep touch bookkeeping current while a touch owns an interaction
      t.x = e.clientX - this.rect.left
      t.y = e.clientY - this.rect.top
    }
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    if (list.length > 0) for (let i = 0; i < list.length; i++) it.move(this.fill(list[i]))
    else it.move(this.fill(e))
    it.flush?.()
  }

  /** One-finger pan / two-finger pinch + pan. */
  private gestureMove(e: PointerEvent, t: { x: number; y: number }): void {
    const nx = e.clientX - this.rect.left
    const ny = e.clientY - this.rect.top
    if (this.touches.size >= 2) {
      let other: { x: number; y: number } | undefined
      for (const [id, p] of this.touches) if (id !== e.pointerId) { other = p; break }
      if (other) {
        const pcx = (t.x + other.x) / 2, pcy = (t.y + other.y) / 2
        const pd = Math.hypot(t.x - other.x, t.y - other.y)
        const ncx = (nx + other.x) / 2, ncy = (ny + other.y) / 2
        const nd = Math.hypot(nx - other.x, ny - other.y)
        if (pd > 1 && nd > 1) this.ed.zoomAt({ x: pcx, y: pcy }, nd / pd)
        this.ed.panBy(ncx - pcx, ncy - pcy)
      }
    } else {
      this.ed.panBy(nx - t.x, ny - t.y)
    }
    t.x = nx
    t.y = ny
  }

  private onPointerUp(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerType === 'pen') this.penDown = Math.max(0, this.penDown - 1)
    this.touches.delete(e.pointerId)
    if (this.ignored.delete(e.pointerId)) return
    try { this.el.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    const it = this.interaction
    if (!it || it.pointerId !== e.pointerId) return
    this.interaction = undefined
    if (cancelled) it.cancel()
    else it.up(this.fill(e))
  }

  private onTap(s: Sample, hit: CanvasObject | undefined): void {
    const now = s.time || Date.now()
    const prev = this.lastTap
    if (prev && now - prev.t < DOUBLE_TAP_MS && Math.hypot(s.x - prev.x, s.y - prev.y) < DOUBLE_TAP_DIST) {
      this.lastTap = undefined
      if (hit && (hit.type === 'text' || hit.type === 'shape' || hit.type === 'arrow')) this.ed.startTextEdit(hit.id)
      return
    }
    this.lastTap = { t: now, x: s.x, y: s.y }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const r = this.el.getBoundingClientRect()
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    const dx = e.deltaX * k
    const dy = e.deltaY * k
    if (e.ctrlKey || e.metaKey) {
      // trackpad pinch (ctrlKey) or modifier + wheel: zoom at cursor
      this.ed.zoomAt({ x: e.clientX - r.left, y: e.clientY - r.top }, Math.exp(-dy * 0.01))
    } else {
      this.ed.panBy(-dx, -dy)
    }
  }

  // -- keyboard ---------------------------------------------------------------------

  private isActive(): boolean {
    const c = this.ed.opts.container
    return this.pointerInside || c.contains(document.activeElement) || document.activeElement === c
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key === ' ') this.spaceDown = false
  }

  private onKeyDown(e: KeyboardEvent): void {
    const ed = this.ed
    if (!this.isActive()) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    if (ed.isEditingText) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const handled = (): void => { e.preventDefault() }

    if (key === ' ') { this.spaceDown = true; return handled() }
    if (key === 'Escape') {
      if (this.interaction) { this.interaction.cancel(); this.interaction = undefined } else ed.clearSelection()
      return handled()
    }
    if (mod) {
      switch (key) {
        case 'z': (e.shiftKey ? ed.redo() : ed.undo()); return handled()
        case 'y': ed.redo(); return handled()
        case 'd': ed.duplicateSelection(); return handled()
        case 'g': (e.shiftKey ? ed.ungroupSelection() : ed.groupSelection()); return handled()
        case 'a': ed.selectAll(); return handled()
        case 'c': ed.copySelection(); return handled()
        case 'x': if (ed.copySelection()) ed.deleteSelection(); return handled()
        case 'v': {
          if (ed.pasteAvailable) { ed.paste(); return handled() }
          void this.pasteSystemText()
          return handled()
        }
      }
      return
    }
    switch (key) {
      case 'Delete':
      case 'Backspace': ed.deleteSelection(); return handled()
      case 'Enter': {
        const only = ed.selection.length === 1 ? ed.selection[0] : undefined
        if (only && ed.startTextEdit(only)) return handled()
        return
      }
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!ed.selection.length) return
        const step = e.shiftKey ? 10 : 1
        ed.nudgeSelection(key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0)
        return handled()
      }
      case 'v': ed.setTool('select'); return handled()
      case 'p': ed.setTool('pen'); return handled()
      case 'h': ed.setTool('highlighter'); return handled()
      case 'e': ed.setTool('eraser'); return handled()
      case 'r': ed.setToolOptions('shape', { kind: 'rectangle' }); ed.setTool('shape'); return handled()
      case 'a': ed.setTool('arrow'); return handled()
      case 't': ed.setTool('text'); return handled()
    }
  }

  private async pasteSystemText(): Promise<void> {
    try {
      const text = await navigator.clipboard?.readText()
      if (text && text.trim()) this.ed.pasteText(text)
    } catch { /* clipboard permission denied */ }
  }
}

// ---------------------------------------------------------------------------
// interactions
// ---------------------------------------------------------------------------

class PanInteraction implements Interaction {
  private lx: number
  private ly: number
  constructor(private ed: Editor, public pointerId: number, s: Sample) { this.lx = s.x; this.ly = s.y }
  move(s: Sample): void {
    this.ed.panBy(s.x - this.lx, s.y - this.ly)
    this.lx = s.x
    this.ly = s.y
  }
  up(): void {}
  cancel(): void {}
}

/** Pen / highlighter: LiveStroke rendered directly to the live layer. */
class StrokeInteraction implements Interaction {
  private flat: number[] = []
  private batch: InkPoint[] = []
  private t0: number
  private startedAt = Date.now()
  private lastX: number
  private lastY: number
  private minDist2: number
  private style
  private pointerType: Sample['pointerType']

  constructor(private ed: Editor, public pointerId: number, s: Sample, private tool: 'pen' | 'highlighter') {
    const o = ed.toolOptions[tool]
    this.style = { tool, color: o.color, width: o.width, opacity: o.opacity, pressureSensitive: o.pressureSensitive }
    this.t0 = s.time
    this.pointerType = s.pointerType
    const d = 0.35 / ed.camera.zoom
    this.minDist2 = d * d
    this.lastX = s.wx
    this.lastY = s.wy
    ed.live.setBackground?.(ed.page?.background.color ?? '#ffffff')
    ed.live.begin(this.style)
    this.push(s)
    this.flush()
  }

  private push(s: Sample): void {
    this.flat.push(s.wx, s.wy, s.pressure, s.tiltX, s.tiltY, Math.max(0, s.time - this.t0))
    this.batch.push({ x: s.wx, y: s.wy, pressure: s.pressure, tiltX: s.tiltX, tiltY: s.tiltY, t: Math.max(0, s.time - this.t0) })
  }

  move(s: Sample): void {
    const dx = s.wx - this.lastX
    const dy = s.wy - this.lastY
    if (dx * dx + dy * dy < this.minDist2) return
    this.lastX = s.wx
    this.lastY = s.wy
    this.push(s)
  }

  flush(): void {
    if (!this.batch.length) return
    this.ed.live.append(this.batch, this.ed.camera)
    this.batch = []
  }

  up(s: Sample): void {
    if (s.wx !== this.lastX || s.wy !== this.lastY) this.push(s)
    if (this.flat.length <= 6) this.push(s) // tap → dot
    this.flush()
    const stroke = buildInkStroke(this.flat, {
      id: createId(), style: this.style, pointerType: this.pointerType, startedAt: this.startedAt, z: this.ed.nextZ(),
    })
    // keep showing the live stroke until the committed one has been rendered
    this.ed.commitStrokeDeferred(stroke)
  }

  cancel(): void {
    this.ed.live.clear()
  }
}

/** Stroke eraser: deletes whole objects the eraser path touches (committed on release). */
class EraserInteraction implements Interaction {
  private erased = new Set<ObjectId>()
  private lx: number
  private ly: number
  constructor(private ed: Editor, public pointerId: number, s: Sample) {
    this.lx = s.wx
    this.ly = s.wy
    this.hit(s.wx, s.wy, s.wx, s.wy)
  }
  private hit(ax: number, ay: number, bx: number, by: number): void {
    const r = this.ed.toolOptions.eraser.size / 2 / this.ed.camera.zoom
    const a = { x: ax, y: ay }
    const b = { x: bx, y: by }
    const pad = r + 20
    const cands = this.ed.queryRect({
      x: Math.min(ax, bx) - pad, y: Math.min(ay, by) - pad, width: Math.abs(ax - bx) + pad * 2, height: Math.abs(ay - by) + pad * 2,
    })
    let changed = false
    for (const o of cands) {
      if (this.erased.has(o.id)) continue
      if (segmentTouchesObject(o, a, b, r, this.ed.resolve)) { this.erased.add(o.id); changed = true }
    }
    if (changed) this.ed.setHiddenIds(this.erased)
  }
  move(s: Sample): void {
    this.hit(this.lx, this.ly, s.wx, s.wy)
    this.lx = s.wx
    this.ly = s.wy
  }
  up(): void {
    this.ed.setHiddenIds([])
    if (this.erased.size) this.ed.deleteObjects(this.erased)
  }
  cancel(): void {
    this.ed.setHiddenIds([])
  }
}

type SelectMode = 'none' | 'move' | 'resize' | 'rotate' | 'endpoint' | 'waypoint' | 'segment' | 'marquee' | 'lasso'

class SelectInteraction implements Interaction {
  private mode: SelectMode = 'none'
  private sx: number
  private sy: number
  private startW: Vec2
  private moved = false
  private leaves: CanvasObject[] = []
  private snap = new Map<ObjectId, CanvasObject>()
  private frame?: SelectionFrame
  private handle?: HandleId
  private startAngle = 0
  private patches: ObjectPatchEntry[] | null = null
  private lasso: Vec2[] = []
  private shift: boolean
  private hit?: CanvasObject
  private hitId?: ObjectId
  private wasSelected = false
  private endpoint?: 'start' | 'end'
  private wpBase: Vec2[] = []
  private handleIndex = 0
  private insertWaypoint = false
  private pathSnapshot: Vec2[] = []
  private lastBindTarget?: ObjectId

  constructor(private ed: Editor, public pointerId: number, s: Sample, private onTap: (s: Sample, hit: CanvasObject | undefined) => void) {
    this.sx = s.x
    this.sy = s.y
    this.startW = { x: s.wx, y: s.wy }
    this.shift = s.shift
    const zoom = ed.camera.zoom
    const hitR = s.pointerType === 'mouse' ? 10 : 18

    // 1. handles / arrow endpoints of the current selection
    if (ed.selection.length) {
      const leaves = ed.leavesOf(ed.selection)
      if (leaves.length === 1 && leaves[0].type === 'arrow') {
        const a = leaves[0]
        const near = (p: Vec2): boolean => Math.hypot((p.x - ed.camera.x) * zoom - s.x, (p.y - ed.camera.y) * zoom - s.y) < hitR
        const handles = ed.selectedArrowHandles() ?? []
        // ends win over waypoints, waypoints over virtual (create-bend) handles
        for (const kind of ['end', 'waypoint', 'virtual'] as const) {
          const h = handles.find((x) => x.kind === kind && near(x.world))
          if (!h) continue
          if (h.id === 'start' || h.id === 'end') this.beginEndpoint(h.id, leaves)
          else this.beginArrowHandle(a as ArrowObject, h.id, kind === 'waypoint' ? 'waypoint' : 'virtual')
          break
        }
      } else {
        const frame = ed.selectionFrame()
        if (frame) {
          const rp = rotationHandlePosition(frame, ROTATE_HANDLE_OFFSET / zoom)
          const dist = (p: Vec2): number => Math.hypot((p.x - ed.camera.x) * zoom - s.x, (p.y - ed.camera.y) * zoom - s.y)
          if (dist(rp) < hitR) {
            this.beginTransform('rotate', leaves, frame)
            this.startAngle = Math.atan2(s.wy - frame.center.y, s.wx - frame.center.x)
          } else {
            for (const h of HANDLE_IDS) {
              if (dist(handlePosition(frame, h)) < hitR) {
                this.handle = h
                this.beginTransform('resize', leaves, frame)
                break
              }
            }
          }
        }
      }
    }
    if (this.mode !== 'none') return

    // 2. object under the pointer
    const hit = ed.hitTest(this.startW, s.pointerType === 'mouse' ? 5 : 10)
    this.hit = hit
    if (hit) {
      const id = ed.topGroupOf(hit.id)
      this.hitId = id
      this.wasSelected = ed.selection.includes(id)
      if (s.shift) {
        ed.select(this.wasSelected ? ed.selection.filter((x) => x !== id) : [...ed.selection, id])
        if (this.wasSelected) return // toggled off: no drag
      } else if (!this.wasSelected) {
        ed.select([id])
      }
      this.leaves = ed.leavesOf(ed.selection)
      this.snapshot(this.leaves)
      this.mode = 'move'
      return
    }
    // 3. empty space → marquee / lasso
    if (!s.shift) ed.clearSelection()
    const m = ed.toolOptions.select.mode
    const lasso = m === 'lasso' || (m === 'auto' && s.pointerType === 'pen')
    this.mode = lasso ? 'lasso' : 'marquee'
    if (lasso) this.lasso = [{ x: s.wx, y: s.wy }]
  }

  private snapshot(leaves: CanvasObject[]): void {
    this.snap.clear()
    for (const l of leaves) this.snap.set(l.id, l)
  }
  private resolveSnap = (id: ObjectId): CanvasObject | undefined => this.snap.get(id) ?? this.ed.resolve(id)

  private beginTransform(mode: 'resize' | 'rotate', leaves: CanvasObject[], frame: SelectionFrame): void {
    this.mode = mode
    this.leaves = leaves
    this.frame = frame
    this.snapshot(leaves)
  }

  /** Waypoint move (`wp:i`), bend creation (curved `v:i`) or elbow segment drag (elbow `v:i`). */
  private beginArrowHandle(a: ArrowObject, id: string, kind: 'waypoint' | 'virtual'): void {
    const idx = Number(id.split(':')[1])
    this.leaves = [a]
    this.snapshot(this.leaves)
    this.wpBase = [...(a.waypoints ?? [])]
    this.handleIndex = idx
    if (a.arrowType === 'elbow') {
      this.mode = 'segment'
      this.pathSnapshot = arrowPath(a, this.resolveSnap)
    } else {
      this.mode = 'waypoint'
      this.insertWaypoint = kind === 'virtual'
    }
  }

  private beginEndpoint(which: 'start' | 'end', leaves: CanvasObject[]): void {
    this.mode = 'endpoint'
    this.endpoint = which
    this.leaves = leaves
    this.snapshot(leaves)
  }

  move(s: Sample): void {
    const ed = this.ed
    const dscreen = Math.hypot(s.x - this.sx, s.y - this.sy)
    switch (this.mode) {
      case 'move': {
        if (!this.moved && dscreen < 3) return
        this.moved = true
        const dx = s.wx - this.startW.x
        const dy = s.wy - this.startW.y
        this.patches = computeMovePatches(this.leaves, dx, dy, this.resolveSnap)
        ed.setPreview(this.patches)
        break
      }
      case 'resize': {
        this.moved = true
        const spec = scaleFromHandle(this.frame!, this.handle!, { x: s.wx, y: s.wy }, s.shift)
        this.patches = computeScalePatches(this.leaves, spec, this.resolveSnap)
        ed.setPreview(this.patches)
        break
      }
      case 'rotate': {
        this.moved = true
        const c = this.frame!.center
        let delta = Math.atan2(s.wy - c.y, s.wx - c.x) - this.startAngle
        if (s.shift) {
          const step = Math.PI / 12
          delta = Math.round((this.frame!.rotation + delta) / step) * step - this.frame!.rotation
        }
        this.patches = computeRotatePatches(this.leaves, c, delta, this.resolveSnap)
        ed.setPreview(this.patches)
        break
      }
      case 'endpoint': {
        this.moved = true
        const arrow = this.leaves[0]
        const key = this.endpoint!
        const bindKey = key === 'start' ? 'startBinding' : 'endBinding'
        const target = ed.findBindingTarget({ x: s.wx, y: s.wy }, new Set([arrow.id]))
        const patch: ObjectPatch = { [key]: { x: s.wx, y: s.wy }, updatedAt: Date.now() } as ObjectPatch
        if (target) (patch as Record<string, unknown>)[bindKey] = { objectId: target.id }
        else patch.$unset = [bindKey]
        this.patches = [{ id: arrow.id, patch }]
        this.lastBindTarget = target?.id
        ed.setPreview(this.patches)
        ed.setOverlayExtra({ bindingTargetId: target?.id })
        break
      }
      case 'waypoint':
      case 'segment': {
        if (!this.moved && dscreen < 3) return
        this.moved = true
        const arrow = this.leaves[0]
        const pos = { x: s.wx, y: s.wy }
        let wps: Vec2[]
        if (this.mode === 'segment') wps = elbowWaypointsAfterDrag(this.pathSnapshot, this.handleIndex, pos)
        else {
          wps = [...this.wpBase]
          if (this.insertWaypoint) wps.splice(this.handleIndex, 0, pos)
          else wps[this.handleIndex] = pos
        }
        this.patches = [{ id: arrow.id, patch: { waypoints: wps, updatedAt: Date.now() } as ObjectPatch }]
        ed.setPreview(this.patches)
        break
      }
      case 'marquee':
        ed.setOverlayExtra({ marquee: rectFromPoints(this.startW, { x: s.wx, y: s.wy }) })
        this.moved = dscreen >= 3
        break
      case 'lasso': {
        const last = this.lasso[this.lasso.length - 1]
        if (Math.hypot(s.wx - last.x, s.wy - last.y) * ed.camera.zoom >= 2) {
          this.lasso.push({ x: s.wx, y: s.wy })
          ed.setOverlayExtra({ lasso: this.lasso })
        }
        this.moved = dscreen >= 3
        break
      }
    }
  }

  up(s: Sample): void {
    const ed = this.ed
    switch (this.mode) {
      case 'move':
      case 'resize':
      case 'rotate':
      case 'endpoint':
      case 'waypoint':
      case 'segment': {
        const patches = this.patches
        ed.setPreview(null)
        ed.setOverlayExtra({})
        if (this.moved && patches) ed.updateObjects(patches) // single commit = one undo step
        else if (this.mode === 'waypoint' && !this.insertWaypoint) this.tapWaypoint(s)
        else if (this.mode === 'move') {
          // a plain tap on a member of a multi-selection selects just that object
          if (!this.shift && this.wasSelected && this.hitId && ed.selection.length > 1) ed.select([this.hitId])
          this.onTap(s, this.hit)
        }
        break
      }
      case 'marquee': {
        const rect = rectFromPoints(this.startW, { x: s.wx, y: s.wy })
        ed.setOverlayExtra({})
        if (this.moved) {
          const ids = ed.objectsInRect(rect).map((o) => o.id)
          ed.select(this.shift ? [...ed.selection, ...ids] : ids)
        } else this.onTap(s, undefined)
        break
      }
      case 'lasso': {
        ed.setOverlayExtra({})
        if (this.moved) {
          const ids = ed.objectsInLasso(this.lasso).map((o) => o.id)
          ed.select(this.shift ? [...ed.selection, ...ids] : ids)
        }
        break
      }
      default: break
    }
  }

  /** Double-tap on an existing waypoint removes it (one undo step). */
  private tapWaypoint(s: Sample): void {
    const now = s.time || Date.now()
    const key = `${this.leaves[0].id}:${this.handleIndex}`
    const prev = lastWaypointTap.get(this.ed)
    if (prev && prev.key === key && now - prev.t < DOUBLE_TAP_MS) {
      lastWaypointTap.delete(this.ed)
      const wps = this.wpBase.filter((_, i) => i !== this.handleIndex)
      const patch: ObjectPatch = { updatedAt: Date.now() }
      if (wps.length) (patch as Record<string, unknown>).waypoints = wps
      else patch.$unset = ['waypoints']
      this.ed.updateObjects([{ id: this.leaves[0].id, patch }])
      return
    }
    lastWaypointTap.set(this.ed, { key, t: now })
  }

  cancel(): void {
    this.ed.setPreview(null)
    this.ed.setOverlayExtra({})
  }
}

const lastWaypointTap = new WeakMap<Editor, { key: string; t: number }>()

class ShapeInteraction implements Interaction {
  private start: Vec2
  private obj?: ShapeObject
  private minPx = 4
  private moved = false
  private sx: number
  private sy: number
  constructor(private ed: Editor, public pointerId: number, s: Sample) {
    this.start = { x: s.wx, y: s.wy }
    this.sx = s.x
    this.sy = s.y
  }
  private build(s: Sample): ShapeObject {
    const o = this.ed.toolOptions.shape
    const geo = shapeGeometry(o.kind, this.start, { x: s.wx, y: s.wy }, s.shift)
    return buildShape(this.obj?.id ?? createId(), o.kind, geo, this.ed.shapeStyle(this.obj?.style.seed), this.ed.nextZ())
  }
  move(s: Sample): void {
    if (!this.moved && Math.hypot(s.x - this.sx, s.y - this.sy) < this.minPx) return
    this.moved = true
    this.obj = this.build(s)
    this.ed.setPreviewObjects([this.obj])
  }
  up(s: Sample): void {
    this.ed.setPreviewObjects([])
    if (!this.moved) return
    const obj = this.build(s)
    const zoom = this.ed.camera.zoom
    if (Math.max(obj.width, obj.height) * zoom < this.minPx) return
    this.ed.addObjects([obj])
    this.ed.select([obj.id])
  }
  cancel(): void {
    this.ed.setPreviewObjects([])
  }
}

class ArrowInteraction implements Interaction {
  private start: Vec2
  private startTarget?: ObjectId
  private moved = false
  private sx: number
  private sy: number
  private id = createId()
  constructor(private ed: Editor, public pointerId: number, s: Sample) {
    this.start = { x: s.wx, y: s.wy }
    this.sx = s.x
    this.sy = s.y
    this.startTarget = ed.findBindingTarget(this.start)?.id
    ed.setOverlayExtra({ bindingTargetId: this.startTarget })
  }
  private build(s: Sample) {
    const o = this.ed.toolOptions.arrow
    let end = { x: s.wx, y: s.wy }
    if (s.shift) end = snapAngle(this.start, end)
    const target = this.ed.findBindingTarget(end)
    const endTarget = target && target.id !== this.startTarget ? target.id : undefined
    const arrowType = this.ed.itemStyle.arrowType
    // new curved arrows get a gentle default bend (drag the handles to reshape)
    const dx = end.x - this.start.x, dy = end.y - this.start.y
    const dist = Math.hypot(dx, dy) || 1
    const waypoints = arrowType === 'curved' && dist > 1
      ? [{ x: this.start.x + dx / 2 + (dy / dist) * dist * 0.18, y: this.start.y + dy / 2 - (dx / dist) * dist * 0.18 }]
      : undefined
    return {
      arrow: buildArrow(this.id, this.start, end, {
        style: this.ed.arrowStyle(), arrowType, waypoints, startHead: o.startHead, endHead: o.endHead, startTarget: this.startTarget, endTarget, z: this.ed.nextZ(),
      }),
      endTarget,
    }
  }
  move(s: Sample): void {
    if (!this.moved && Math.hypot(s.x - this.sx, s.y - this.sy) < 4) return
    this.moved = true
    const { arrow, endTarget } = this.build(s)
    this.ed.setPreviewObjects([arrow])
    this.ed.setOverlayExtra({ bindingTargetId: endTarget ?? this.startTarget })
  }
  up(s: Sample): void {
    this.ed.setPreviewObjects([])
    this.ed.setOverlayExtra({})
    if (!this.moved) return
    const { arrow } = this.build(s)
    if (Math.hypot(arrow.end.x - arrow.start.x, arrow.end.y - arrow.start.y) * this.ed.camera.zoom < 8) return
    this.ed.addObjects([arrow])
    this.ed.select([arrow.id])
  }
  cancel(): void {
    this.ed.setPreviewObjects([])
    this.ed.setOverlayExtra({})
  }
}

/** Text tool: a tap creates text (or edits the text/label under the pointer). */
class TextTapInteraction implements Interaction {
  private sx: number
  private sy: number
  private moved = false
  constructor(private ed: Editor, public pointerId: number, s: Sample) { this.sx = s.x; this.sy = s.y }
  move(s: Sample): void {
    if (Math.hypot(s.x - this.sx, s.y - this.sy) > TAP_MAX_MOVE) this.moved = true
  }
  up(s: Sample): void {
    if (this.moved) return
    const p = { x: s.wx, y: s.wy }
    const hit = this.ed.hitTest(p)
    if (hit && this.ed.startTextEdit(hit.id)) return
    this.ed.startTextAt(p)
  }
  cancel(): void {}
}
