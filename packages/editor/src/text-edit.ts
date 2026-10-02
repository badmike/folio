/**
 * DOM text-editing overlay: a positioned <textarea> that tracks the camera.
 * Handles new text objects, editing existing text and editing shape/arrow labels.
 */
import { DEFAULT_LABEL_SIZE, type ObjectId, type ShapeObject, type TextObject, type Transform, type Vec2 } from '@folio/document'
import { ARROW_LABEL_WIDTH, FONT_FAMILIES, FRAME_LABEL_SIZE, arrowPath, frameColor, labelLayout, layoutText, pathMidpoint, type TextLayout } from '@folio/renderer'
import type { Editor } from './editor'
import { IDENTITY, createId, localToWorld } from './geometry'

/** Horizontal padding around the text, in screen pixels. */
const CARET_ROOM = 2

interface Placement {
  transform: Transform
  /** Top-left of the layout box in the transform's local space. */
  origin: Vec2
  layout: TextLayout
  fontSize: number
  family: string
  color: string
  align: 'left' | 'center' | 'right'
  wrap: boolean
}

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
      position: 'absolute', margin: '0', border: 'none', outline: '1px dashed rgba(80,120,255,0.7)',
      background: 'transparent', resize: 'none', overflow: 'hidden', pointerEvents: 'auto', transformOrigin: '0 0',
      boxSizing: 'content-box', letterSpacing: 'normal', wordSpacing: 'normal', textIndent: '0', touchAction: 'auto', userSelect: 'text',
    })
    el.addEventListener('input', () => this.reposition())
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

  /**
   * Re-apply position, size and font from the current camera and value. The textarea's
   * content box is the renderer's layout box for the same text, so typed and drawn text coincide.
   */
  reposition(): void {
    const el = this.el
    const mode = this.mode
    if (!el || !mode) return
    const p = this.placement(mode, el.value)
    if (!p) return
    const z = this.editor.zoom
    const s = this.editor.worldToScreen(localToWorld(p.transform, p.origin))
    // padding leaves room for the caret and for glyphs reaching past the line boxes (which would
    // otherwise scroll the textarea); the translate puts the content box back on the layout box
    const padX = CARET_ROOM
    const padY = p.layout.overhang * z
    Object.assign(el.style, {
      left: `${s.x}px`, top: `${s.y}px`, width: `${p.layout.width * z}px`, height: `${p.layout.height * z}px`, padding: `${padY}px ${padX}px`,
      fontSize: `${p.fontSize * z}px`, lineHeight: String(p.layout.lineHeight / p.fontSize), fontFamily: p.family,
      color: p.color, textAlign: p.align, whiteSpace: p.wrap ? 'pre-wrap' : 'pre',
      transform: `rotate(${p.transform.rotation}rad) scale(${p.transform.scaleX}, ${p.transform.scaleY}) translate(${-padX}px, ${-padY}px)`,
    })
  }

  /** Layout box of the edited text in the object's local space, mirroring how the renderer draws it. */
  private placement(mode: Mode, value: string): Placement | undefined {
    const clean = this.editor.theme === 'clean'
    if (mode.kind === 'label') {
      const o = this.editor.getObject(mode.id)
      if (o?.type === 'shape' && o.kind === 'frame') {
        const fontSize = o.labelSize ?? FRAME_LABEL_SIZE
        const layout = layoutText({ text: value, fontSize, fontFamily: 'sans', align: 'left' })
        const color = frameColor(this.editor.page?.background.color ?? '#ffffff')
        return { transform: o.transform, origin: { x: 0, y: -layout.height - 2 }, layout, fontSize, family: FONT_FAMILIES.sans, color, align: 'left', wrap: false }
      }
      if (o?.type !== 'shape' && o?.type !== 'arrow') return undefined
      const fontSize = o.labelSize ?? DEFAULT_LABEL_SIZE
      const family = clean ? FONT_FAMILIES.sans : FONT_FAMILIES.hand
      const label = { family, color: o.style.strokeColor, align: 'center', wrap: true, fontSize } as const
      if (o.type === 'shape') {
        const layout = labelLayout(value, o.width, clean, false, fontSize)
        return { ...label, transform: o.transform, origin: { x: (o.width - layout.width) / 2, y: (o.height - layout.height) / 2 }, layout }
      }
      // the box spans the full wrap width; centered lines land where the renderer's fitted box puts them
      const layout = labelLayout(value, ARROW_LABEL_WIDTH, clean, false, fontSize)
      const mid = pathMidpoint(arrowPath(o, this.editor.resolve))
      return { ...label, transform: IDENTITY, origin: { x: mid.x - layout.width / 2, y: mid.y - layout.height / 2 }, layout }
    }
    const t = mode.kind === 'new' ? mode.draft : this.editor.getObject(mode.id)
    if (t?.type !== 'text') return undefined
    const layout = layoutText({ ...t, text: value })
    return {
      transform: t.transform, origin: { x: 0, y: 0 }, layout, fontSize: t.fontSize,
      family: FONT_FAMILIES[t.fontFamily], color: t.color, align: t.align ?? 'left', wrap: !!t.width,
    }
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
