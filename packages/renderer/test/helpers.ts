import type { ArrowObject, CanvasObject, ImageObject, InkStroke, Page, ShapeObject, TextObject, Transform } from '@folio/document'
import type { Scene } from '../src/contract'
import { setTextMeasurer } from '../src/text'

export const T: Transform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }

// deterministic text metrics: 10px per char at any size 20 → 0.5*size per char
export function useFakeMeasure(): void {
  setTextMeasurer((font, text) => {
    const m = /(\d+(?:\.\d+)?)px/.exec(font)
    return text.length * (m ? parseFloat(m[1]) : 16) * 0.5
  })
}

const base = { z: 0, createdAt: 1, updatedAt: 1 }

export function ink(id: string, pts: [number, number, number?][], over: Partial<InkStroke> = {}): InkStroke {
  const flat: number[] = []
  pts.forEach(([x, y, p], i) => flat.push(x, y, p ?? 0.5, 0, 0, i * 10))
  return {
    ...base, id, type: 'ink', transform: { ...T }, points: flat, startedAt: 0, pointerType: 'pen',
    style: { tool: 'pen', color: '#000000', width: 4, opacity: 1, pressureSensitive: true },
    ...over,
  }
}

export function shape(id: string, kind: ShapeObject['kind'], w: number, h: number, over: Partial<ShapeObject> = {}, style: Partial<ShapeObject['style']> = {}): ShapeObject {
  return {
    ...base, id, type: 'shape', kind, width: w, height: h, transform: { ...T },
    style: { strokeColor: '#111111', strokeWidth: 2, opacity: 1, roughness: 1, seed: 42, ...style },
    ...over,
  }
}

export function arrow(id: string, start: { x: number; y: number }, end: { x: number; y: number }, over: Partial<ArrowObject> = {}): ArrowObject {
  return {
    ...base, id, type: 'arrow', transform: { ...T }, start, end, startHead: 'none', endHead: 'arrow',
    style: { strokeColor: '#111111', strokeWidth: 2, opacity: 1, roughness: 1, seed: 7 },
    ...over,
  }
}

export function text(id: string, str: string, over: Partial<TextObject> = {}): TextObject {
  return { ...base, id, type: 'text', transform: { ...T }, text: str, fontSize: 20, fontFamily: 'sans', color: '#000', ...over }
}

export function image(id: string, w: number, h: number): ImageObject {
  return { ...base, id, type: 'image', transform: { ...T }, assetId: 'a-' + id, mimeType: 'image/png', width: w, height: h }
}

export const PAGE: Page = {
  id: 'p', title: 'p', kind: 'infinite', order: 1, createdAt: 1, updatedAt: 1,
  background: { pattern: 'grid', spacing: 32, opacity: 0.4, color: '#ffffff', lineColor: '#9aa' },
}

export function scene(objects: CanvasObject[], over: Partial<Scene> = {}): Scene {
  const map = new Map(objects.map((o) => [o.id, o]))
  return { page: PAGE, objects, resolve: (id) => map.get(id), theme: 'rough', ...over }
}
