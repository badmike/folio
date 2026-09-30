/**
 * DOM text-editing overlay: a positioned <textarea> that tracks the camera.
 * Handles new text objects, editing existing text and editing shape/arrow labels.
 */
import { DEFAULT_LABEL_SIZE, type ObjectId, type ShapeObject, type TextObject, type Vec2 } from '@folio/document'
import { FONT_FAMILIES, FRAME_LABEL_SIZE, frameColor } from '@folio/renderer'
import type { Editor } from './editor'
import { LINE_HEIGHT, createId, localBounds, localToWorld, resolveArrowEndpoints } from './geometry'

type Mode =
  | { kind: 'new'; draft: TextObject }
  | { kind: 'text'; id: ObjectId }
  | { kind: 'label'; id: ObjectId }

export class TextEditor {
  private el?: HTMLTextAreaElement
  private mode?: Mode
  /** Existing object hidden from the scene while its text is edited in the DOM. */
  editingId?: ObjectId

  constructor(private editor: Editor) {}

  get active(): boolean {
    return !!this.el
  }

  startNew(p: Vec2): void {
    if (this.editor.readOnly) return
    this.commit()
    const t = this.editor.itemStyle
    const now = Date.now()
    const draft: TextObject = {
      id: createId(), type: 'text', z: this.editor.nextZ(), createdAt: now, updatedAt: now,
      transform: { x: p.x, y: p.y - t.fontSize * 0.65, rotation: 0, scaleX: 1, scaleY: 1 },
      text: '', fontSize: t.fontSize, fontFamily: t.fontFamily, color: t.strokeColor, align: t.textAlign, opacity: t.opacity,
    }
    this.open({ kind: 'new', draft }, '')
  }

  /** Edit a text object or the label of a shape/arrow. Returns false if not editable. */
  startExisting(id: ObjectId): boolean {
    if (this.editor.readOnly) return false
    const o = this.editor.getObject(id)
    if (!o) return false
    if (o.type === 'text') {
      this.commit()
      this.editingId = id
      this.open({ kind: 'text', id }, o.text)
      return true
    }
    if (o.type === 'shape' || o.type === 'arrow') {
      this.commit()
      this.open({ kind: 'label', id }, o.label ?? '')
      // hide the rendered label while the DOM editor is showing it
      this.editor.setPreview([{ id, patch: { label: '' } }])
      return true
    }
    return false
  }

  private open(mode: Mode, value: string): void {
    this.mode = mode
    const el = document.createElement('textarea')
    el.value = value
    el.spellcheck = false
    el.setAttribute('data-folio-text', '')
    Object.assign(el.style, {
      position: 'absolute', margin: '0', padding: '0 2px', border: '1px dashed rgba(80,120,255,0.7)', outline: 'none',
      background: 'transparent', resize: 'none', overflow: 'hidden', pointerEvents: 'auto', transformOrigin: '0 0',
      whiteSpace: 'pre', lineHeight: String(LINE_HEIGHT), boxSizing: 'content-box', touchAction: 'auto', userSelect: 'text',
    })
    el.addEventListener('input', () => this.autosize())
    el.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        this.commit()
      }
    })
    el.addEventListener('blur', () => this.commit())
    el.addEventListener('pointerdown', (e) => e.stopPropagation())
    this.el = el
    this.editor.domLayer.appendChild(el)
    this.reposition()
    el.focus()
    if (mode.kind !== 'new') el.select()
    this.editor.events.emit('textedit', { editing: true, id: mode.kind === 'new' ? mode.draft.id : mode.id })
    this.editor.requestRender()
  }

  /** Re-apply position/scale from the current camera. */
  reposition(): void {
    const el = this.el
    const mode = this.mode
    if (!el || !mode) return
    const z = this.editor.zoom
    if (mode.kind === 'label') {
      const o = this.editor.getObject(mode.id)
      if (!o) return
      let center: Vec2
      let width = 200
      let rot = 0
      const family = this.editor.theme === 'clean' ? FONT_FAMILIES.sans : FONT_FAMILIES.hand
      if (o.type === 'shape' && o.kind === 'frame') {
        // the frame name sits above the top-left corner, left aligned
        const size = o.labelSize ?? FRAME_LABEL_SIZE
        const s = this.editor.worldToScreen(localToWorld(o.transform, { x: 0, y: -size * 1.3 - 2 }))
        Object.assign(el.style, {
          left: `${s.x}px`, top: `${s.y}px`, fontSize: `${size * z}px`, fontFamily: FONT_FAMILIES.sans,
          color: frameColor(this.editor.page?.background.color ?? '#ffffff'), textAlign: 'left',
          transform: `rotate(${o.transform.rotation}rad)`, minWidth: `${60 * z}px`,
        })
        this.autosize()
        return
      }
      const size = o.type === 'shape' || o.type === 'arrow' ? o.labelSize ?? DEFAULT_LABEL_SIZE : DEFAULT_LABEL_SIZE
      if (o.type === 'shape') {
        const lb = localBounds(o)!
        center = localToWorld(o.transform, { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 })
        width = Math.max(60, Math.abs(o.width * o.transform.scaleX) - 8)
        rot = o.transform.rotation
      } else if (o.type === 'arrow') {
        const { start, end } = resolveArrowEndpoints(o, this.editor.resolve)
        center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      } else return
      const s = this.editor.worldToScreen(center)
      Object.assign(el.style, {
        left: `${s.x}px`, top: `${s.y}px`, fontSize: `${size * z}px`, fontFamily: family, color: o.style.strokeColor,
        textAlign: 'center', transform: `translate(-50%,-50%) rotate(${rot}rad)`, minWidth: `${Math.min(width, 120) * z}px`,
      })
      this.autosize()
      return
    }
    const t = mode.kind === 'new' ? mode.draft : (this.editor.getObject(mode.id) as TextObject | undefined)
    if (!t || t.type !== 'text') return
    const s = this.editor.worldToScreen({ x: t.transform.x, y: t.transform.y })
    const scale = t.transform.scaleY
    Object.assign(el.style, {
      left: `${s.x}px`, top: `${s.y}px`, fontSize: `${t.fontSize * scale * z}px`,
      fontFamily: FONT_FAMILIES[t.fontFamily], color: t.color, textAlign: t.align ?? 'left',
      transform: `rotate(${t.transform.rotation}rad)`,
      whiteSpace: t.width ? 'pre-wrap' : 'pre',
    })
    if (t.width) el.style.width = `${t.width * t.transform.scaleX * z}px`
    this.autosize()
  }

  private autosize(): void {
    const el = this.el
    if (!el) return
    if (this.mode?.kind === 'text' || this.mode?.kind === 'new') {
      const t = this.mode.kind === 'new' ? this.mode.draft : (this.editor.getObject(this.mode.id) as TextObject | undefined)
      if (t?.width) {
        el.style.height = '0px'
        el.style.height = `${el.scrollHeight}px`
        return
      }
    }
    el.style.width = '0px'
    el.style.height = '0px'
    el.style.width = `${Math.max(el.scrollWidth + 4, 24)}px`
    el.style.height = `${Math.max(el.scrollHeight, 8)}px`
  }

  /** Finish editing and commit the result as one undoable step. */
  commit(): void {
    const el = this.el
    const mode = this.mode
    if (!el || !mode) return
    this.el = undefined
    this.mode = undefined
    const value = el.value
    const editedId = this.editingId
    this.editingId = undefined
    el.remove()
    this.editor.setPreview(null)
    const ed = this.editor
    if (mode.kind === 'new') {
      if (value.trim()) {
        const obj = { ...mode.draft, text: value, updatedAt: Date.now() }
        ed.addObjects([obj])
        ed.afterCreate()
        if (ed.tool === 'select') ed.select([obj.id])
      }
    } else if (mode.kind === 'text') {
      const o = ed.getObject(mode.id)
      if (o?.type === 'text') {
        if (!value.trim()) ed.deleteObjects([mode.id])
        else if (value !== o.text) ed.updateObjects([{ id: mode.id, patch: { text: value } }])
      }
    } else {
      const o = ed.getObject(mode.id) as ShapeObject | undefined
      if (o) {
        const label = value.trim() ? value : undefined
        if (label !== o.label) ed.updateObjects([{ id: mode.id, patch: label === undefined ? { $unset: ['label'] } : { label } }])
      }
    }
    void editedId
    ed.events.emit('textedit', { editing: false, id: mode.kind === 'new' ? mode.draft.id : mode.id })
    ed.requestRender()
  }

  destroy(): void {
    const el = this.el
    this.el = undefined
    this.mode = undefined
    this.editingId = undefined
    el?.remove()
  }
}
