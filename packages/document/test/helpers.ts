import {
  createId, defaultShapeStyle, encodeInkPoints, identityTransform,
  type ArrowObject, type CanvasObject, type InkStroke, type ShapeObject, type TextObject, type Recognition,
} from '../src'

let z = 0
export const stroke = (x = 0, y = 0, n = 5, over: Partial<InkStroke> = {}): InkStroke => ({
  id: createId(), type: 'ink', transform: identityTransform(), z: ++z, createdAt: 1, updatedAt: 1,
  points: encodeInkPoints(Array.from({ length: n }, (_, i) => ({ x: x + i * 3, y: y + (i % 2) * 2, pressure: 0.5, tiltX: 0, tiltY: 0, t: i * 8 }))),
  style: { tool: 'pen', color: '#1e1e1e', width: 2.5, opacity: 1, pressureSensitive: true },
  startedAt: 1, pointerType: 'pen', ...over,
})

export const text = (t: string, x: number, y: number, over: Partial<TextObject> = {}): TextObject => ({
  id: createId(), type: 'text', transform: { ...identityTransform(), x, y }, z: ++z, createdAt: 1, updatedAt: 1,
  text: t, fontSize: 16, fontFamily: 'sans', color: '#1e1e1e', ...over,
})

export const shape = (x: number, y: number, w = 100, h = 60, over: Partial<ShapeObject> = {}): ShapeObject => ({
  id: createId(), type: 'shape', kind: 'rectangle', transform: { ...identityTransform(), x, y }, z: ++z,
  createdAt: 1, updatedAt: 1, width: w, height: h, style: defaultShapeStyle(), ...over,
})

export const arrow = (over: Partial<ArrowObject> = {}): ArrowObject => ({
  id: createId(), type: 'arrow', transform: identityTransform(), z: ++z, createdAt: 1, updatedAt: 1,
  start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, style: defaultShapeStyle(), startHead: 'none', endHead: 'arrow', ...over,
})

export const textRec = (t: string, x: number, y: number, w: number, h: number, strokeIds: string[], over: Partial<Recognition> = {}): Recognition => ({
  id: createId(), kind: 'text', strokeIds, bounds: { x, y, width: w, height: h }, text: t, confidence: 0.9,
  recognizer: 'test', createdAt: 1, ...over,
})

export const snapshotState = (doc: { pages(): unknown[]; objects(p: string): CanvasObject[]; recognitions(p: string): unknown[]; meta(): unknown; pages(): { id: string }[] }) => {
  const pages = doc.pages() as { id: string }[]
  return JSON.parse(JSON.stringify({
    meta: doc.meta(), pages,
    objects: pages.map((p) => doc.objects(p.id)),
    recs: pages.map((p) => doc.recognitions(p.id)),
  }))
}
