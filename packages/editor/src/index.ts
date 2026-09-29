export { Editor, createEditor, defaultToolOptions } from './editor'
export * from './types'
export { Emitter } from './emitter'
export { SpatialIndex } from './spatial-index'
export * from './camera'
export { buildInkStroke } from './ink'
export { shapeGeometry, buildShape, buildArrow, snapAngle } from './create'
export {
  applyPatch, computeFrame, computeMovePatches, computeRotatePatches, computeScalePatches, scaleFromHandle, cloneObjects,
  handlePosition, rotationHandlePosition, HANDLE_IDS,
} from './manipulate'
export type { ObjectPatchEntry, SelectionFrame, ScaleSpec, HandleId, CloneResult } from './manipulate'
