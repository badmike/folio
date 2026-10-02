export * from './contract'
export { createLiveInkLayer, pressureFactor } from './live-ink'
export { strokeOutline, strokeFill, triangulate, freehandOptions, highlighterOutline, highlighterParts, type StrokeFill } from './geometry/ink'
export {
  buildShapeGeometry, buildArrowGeometry, opsetToPolylines, arrowHeadPoints, arrowHeadLength, effectiveRoughness,
  arrowheadParts, pathEndTangent, wobblePath, type HeadParts,
  type PathGeometry,
} from './geometry/rough'
export { MeshBuilder, addPolyline, addPolygon, addGeometry, buildInkMesh, buildInkStencilMesh, type StencilFill, buildShapeMesh, buildArrowMesh, VERTEX_FLOATS } from './geometry/mesh'
export {
  resolveArrowEndpoints, arrowPath, arrowHandleSpecs, elbowWaypointsAfterDrag, arrowTypeOf, ELBOW_GAP, lineHandleSpecs, linePointsAfterDrag,
  type ArrowHandleSpec, type PathHandleSpec,
} from './arrows'
export { catmullRom, orthogonalRoute, simplifyOrthogonal, dashPattern, dashPolyline, type FlatCurve } from './geometry/curves'
export { hitTestObject, objectIntersectsRect, objectIntersectsLasso, pointInPolygon, frameLabelRect, FRAME_LABEL_SIZE } from './hit'
export { localBounds, localOutline, worldCorners, objectWorldBounds, inkLocalPoints, type Resolve } from './bounds'
export { FONT_FAMILIES, FONT_LABELS, WEB_FONT_NAMES, fontString, measureText, layoutText, labelLayout, ARROW_LABEL_WIDTH, setTextMeasurer, resetTextMetrics, type TextLayout, type TextLike } from './text'
export { shapeOutline, shapeVertices, roundedPolygon, cornerRadius } from './shapes'
export {
  patternCoverage, patternCoverageLevels, patternFade, patternKind, pageRect, DESK_COLOR, DESK_COLOR_DARK, patternLevels,
  backgroundLevels, patternColor, frameColor, DYNAMIC_MIN_PX, MINOR_WEIGHT, type PatternLevel,
} from './background'
export {
  buildOverlay, selectionHandles, worldToScreen, ACCENT, HANDLE_SIZE, ROTATE_HANDLE_OFFSET,
  type HandleId, type OverlayPoly,
} from './overlay'
export { WebGLRenderer, scaleBucket } from './webgl'
export { Canvas2DRenderer, renderToCanvas, renderPageToImage, paintScene, pathMidpoint, GeometryStore, type PageImageOptions, type PaintOptions } from './canvas2d'
export { ImageCache, type ImageResolver, type ImageSource } from './images'
export { createRenderer, type CreateRendererOptions } from './factory'
export { parseColor, premultiplied } from './color'
