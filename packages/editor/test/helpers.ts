import { NotebookDocument } from '@folio/document'
import type { CanvasObject, InkStroke, ShapeObject, TextObject, ArrowObject } from '@folio/document'
import type { LiveInkLayer, Renderer, Scene } from '@folio/renderer'
import { vi } from 'vitest'
import { Editor, createEditor } from '../src'
import type { EditorOptions } from '../src'

export class FakeRenderer implements Renderer {
  scenes: Scene[] = []
  invalidated: string[][] = []
  render = vi.fn((scene: Scene) => { this.scenes.push(scene) })
  resize = vi.fn()
  invalidate = vi.fn((ids?: Iterable<string>) => { this.invalidated.push(ids ? [...ids] : ['*']) })
  dispose = vi.fn()
  get last(): Scene { return this.scenes[this.scenes.length - 1] }
}

export class FakeLive implements LiveInkLayer {
  begun = 0
  points = 0
  cleared = 0
  begin = vi.fn(() => { this.begun++ })
  append = vi.fn((pts: unknown[]) => { this.points += pts.length })
  finish = vi.fn()
  clearCommitted = vi.fn(() => { this.cleared++ })
  cancel = vi.fn()
  redraw = vi.fn()
  clear = vi.fn(() => { this.cleared++ })
  resize = vi.fn()
  dispose = vi.fn()
}

export interface Harness {
  editor: Editor
  doc: NotebookDocument
  pageId: string
  renderer: FakeRenderer
  live: FakeLive
  container: HTMLElement
  ops: unknown[][]
  strokes: InkStroke[]
}

export function setup(o: Partial<EditorOptions> & { fixed?: boolean; size?: [number, number] } = {}): Harness {
  const doc = NotebookDocument.create({ title: 't' })
  const pageId = doc.pages()[0].id
  const container = document.createElement('div')
  document.body.appendChild(container)
  const [w, h] = o.size ?? [1000, 800]
  Object.defineProperty(container, 'clientWidth', { value: w, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: h, configurable: true })
  const renderer = new FakeRenderer()
  const live = new FakeLive()
  const ops: unknown[][] = []
  const strokes: InkStroke[] = []
  const editor = createEditor({
    container, document: doc, pageId, rendererFactory: () => renderer, liveLayerFactory: () => live,
    onOperations: (x) => ops.push(x), onStrokeCommitted: (_p, s) => strokes.push(s), ...o,
  })
  editor.measure(w, h, 1)
  editor.setCamera({ x: 0, y: 0, zoom: 1 })
  return { editor, doc, pageId, renderer, live, container, ops, strokes }
}

export const now = 1_700_000_000_000
const ident = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }

export function shape(id: string, x: number, y: number, w = 100, h = 60, extra: Partial<ShapeObject> = {}): ShapeObject {
  return {
    id, type: 'shape', kind: 'rectangle', transform: { ...ident, x, y }, z: 1, createdAt: now, updatedAt: now, width: w, height: h,
    style: { strokeColor: '#000', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1 }, ...extra,
  }
}

export function ink(id: string, pts: [number, number][], x = 0, y = 0, extra: Partial<InkStroke> = {}): InkStroke {
  const flat: number[] = []
  for (const [px, py] of pts) flat.push(px, py, 0.5, 0, 0, 0)
  return {
    id, type: 'ink', transform: { ...ident, x, y }, z: 1, createdAt: now, updatedAt: now, points: flat,
    style: { tool: 'pen', color: '#000', width: 2, opacity: 1, pressureSensitive: true }, startedAt: now, pointerType: 'pen', ...extra,
  }
}

export function text(id: string, x: number, y: number, t = 'hello', extra: Partial<TextObject> = {}): TextObject {
  return {
    id, type: 'text', transform: { ...ident, x, y }, z: 1, createdAt: now, updatedAt: now, text: t, fontSize: 20,
    fontFamily: 'sans', color: '#000', ...extra,
  }
}

export function arrow(id: string, sx: number, sy: number, ex: number, ey: number, extra: Partial<ArrowObject> = {}): ArrowObject {
  return {
    id, type: 'arrow', transform: { ...ident }, z: 2, createdAt: now, updatedAt: now, start: { x: sx, y: sy }, end: { x: ex, y: ey },
    style: { strokeColor: '#000', strokeWidth: 2, opacity: 1, roughness: 0, seed: 1 }, startHead: 'none', endHead: 'arrow', ...extra,
  }
}

export function addRaw(h: Harness, objects: CanvasObject[]): void {
  h.doc.apply([{ type: 'addObjects', pageId: h.pageId, objects }], 'journal')
}

/** Dispatch a synthetic pointer event onto the editor root. */
export function pointer(
  h: Harness, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y: number,
  o: { id?: number; pointerType?: string; pressure?: number; button?: number; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; tiltX?: number; time?: number; coalesced?: [number, number][] } = {},
): void {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>
  const rect = h.editor.root.getBoundingClientRect()
  const props: Record<string, unknown> = {
    pointerId: o.id ?? 1, pointerType: o.pointerType ?? 'mouse', clientX: x + rect.left, clientY: y + rect.top,
    pressure: o.pressure ?? 0.5, button: o.button ?? 0, buttons: o.button === 5 ? 32 : 1, shiftKey: !!o.shiftKey, ctrlKey: !!o.ctrlKey, altKey: !!o.altKey, tiltX: o.tiltX ?? 0, tiltY: 0,
    timeStamp: o.time ?? performance.now(),
  }
  const define = (t: object, p: Record<string, unknown>) => { for (const [k, v] of Object.entries(p)) Object.defineProperty(t, k, { value: v, configurable: true }) }
  define(ev, props)
  if (o.coalesced) {
    ev.getCoalescedEvents = () => o.coalesced!.map(([cx, cy], i) => ({
      ...props, clientX: cx + rect.left, clientY: cy + rect.top, pressure: 0.2 + i * 0.1, timeStamp: (props.timeStamp as number) + i,
    }))
  }
  h.editor.root.dispatchEvent(ev)
}

export function drag(h: Harness, from: [number, number], to: [number, number], o: Parameters<typeof pointer>[4] = {}, steps = 4): void {
  pointer(h, 'pointerdown', from[0], from[1], o)
  for (let i = 1; i <= steps; i++) {
    pointer(h, 'pointermove', from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, o)
  }
  pointer(h, 'pointerup', to[0], to[1], o)
}

export function key(k: string, o: { meta?: boolean; shift?: boolean; ctrl?: boolean } = {}): void {
  const e = new KeyboardEvent('keydown', { key: k, metaKey: o.meta, ctrlKey: o.ctrl, shiftKey: o.shift, bubbles: true, cancelable: true })
  window.dispatchEvent(e)
}

export const objs = (h: Harness) => h.doc.objects(h.pageId)
