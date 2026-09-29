export * from './contract'
export { createLiveInkLayer, pressureFactor } from './live-ink'
export { strokeOutline, triangulate, freehandOptions } from './geometry/ink'
export {
  buildShapeGeometry, buildArrowGeometry, opsetToPolylines, arrowHeadPoints, arrowHeadLength, effectiveRoughness,
  type PathGeometry,
} from './geometry/rough'
export { MeshBuilder, addPolyline, addPolygon, addGeometry, buildInkMesh, buildShapeMesh, buildArrowMesh, VERTEX_FLOATS } from './geometry/mesh'
export { resolveArrowEndpoints } from './arrows'
export { hitTestObject, objectIntersectsRect, objectIntersectsLasso, pointInPolygon } from './hit'
export { localBounds, localOutline, worldCorners, objectWorldBounds, inkLocalPoints, type Resolve } from './bounds'
export { FONT_FAMILIES, fontString, measureText, layoutText, setTextMeasurer, resetTextMetrics, type TextLayout, type TextLike } from './text'
export { shapeOutline } from './shapes'
export { patternCoverage, patternFade, patternKind, pageRect, DESK_COLOR } from './background'
export {
  buildOverlay, selectionHandles, worldToScreen, ACCENT, HANDLE_SIZE, ROTATE_HANDLE_OFFSET,
  type HandleId, type OverlayPoly,
} from './overlay'
export { WebGLRenderer, scaleBucket } from './webgl'
export { Canvas2DRenderer, renderToCanvas, renderPageToImage, paintScene, GeometryStore, type PageImageOptions, type PaintOptions } from './canvas2d'
export { ImageCache, type ImageResolver, type ImageSource } from './images'
export { createRenderer, type CreateRendererOptions } from './factory'
export { parseColor, premultiplied } from './color'
