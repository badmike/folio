import {
  createId, identityTransform,
  type ArrowObject, type CanvasObject, type Operation, type ShapeObject, type ShapeStyle, type TextObject,
} from '@folio/document'

/**
 * Content of the first-run "Welcome" notebook: a heading, a few lines and a small
 * rectangle -> arrow -> ellipse diagram so people see semantic objects right away.
 * World origin (0,0) is the centre of the initial view.
 */
export function welcomeOperations(pageId: string, now = Date.now()): Operation[] {
  let z = 0
  const base = () => ({ transform: identityTransform(), z: ++z, createdAt: now, updatedAt: now })
  const style = (seed: number, extra: Partial<ShapeStyle> = {}): ShapeStyle => ({
    strokeColor: '#1e1e1e', strokeWidth: 2, opacity: 1, roughness: 1, seed, ...extra,
  })
  const text = (x: number, y: number, s: string, o: Partial<TextObject> = {}): TextObject => ({
    id: createId(), type: 'text', text: s, fontSize: 20, fontFamily: 'sans', color: '#1e1e1e', width: 640,
    ...base(), ...o, transform: { ...identityTransform(), x, y },
  })
  const shape = (kind: ShapeObject['kind'], x: number, y: number, w: number, h: number, label: string, st: ShapeStyle): ShapeObject => ({
    id: createId(), type: 'shape', kind, width: w, height: h, label, style: st,
    ...base(), transform: { ...identityTransform(), x, y },
  })

  const objects: CanvasObject[] = []
  objects.push(text(-330, -250, 'Welcome to folio', { fontSize: 48, fontFamily: 'hand', semanticType: 'heading', width: undefined }))
  objects.push(text(-330, -170, '• Draw with Apple Pencil, a stylus or the mouse. Everything is saved on this device, even offline.', { semanticType: 'list-item' }))
  objects.push(text(-330, -110, '• Select ink and tap Clean Up to turn handwriting and rough shapes into text and diagrams.', { semanticType: 'list-item' }))
  objects.push(text(-330, -50, '• Use the toolbar for shapes, arrows and text. Pinch or scroll to zoom, two fingers to pan.', { semanticType: 'list-item' }))

  const rect = shape('rectangle', -330, 60, 170, 80, 'Sketch', style(11, { fillColor: '#ffec99' }))
  const ell = shape('ellipse', 10, 50, 220, 100, 'Diagram', style(23, { fillColor: '#a5d8ff' }))
  const arrow: ArrowObject = {
    id: createId(), type: 'arrow', ...base(), start: { x: -160, y: 100 }, end: { x: 10, y: 100 },
    startBinding: { objectId: rect.id }, endBinding: { objectId: ell.id },
    style: style(37), startHead: 'none', endHead: 'arrow', label: 'clean up',
  }
  objects.push(rect, arrow, ell)
  objects.push(text(-330, 190, 'Search finds typed text, handwriting and diagram labels. Try it!', { fontSize: 18, semanticType: 'paragraph' }))
  return [{ type: 'addObjects', pageId, objects }]
}
