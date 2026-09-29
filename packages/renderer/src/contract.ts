import type { ArrowObject, CanvasObject, InkPoint, ObjectId, Page, Rect, StrokeStyle, Vec2 } from '@folio/document'

/** Camera: screen = (world - (x,y)) * zoom. (x,y) is the world point at the viewport's top-left. */
export interface Camera {
  x: number
  y: number
  zoom: number
}

export interface Size {
  width: number
  height: number
  /** devicePixelRatio */
  dpr: number
}

export type VisualTheme = 'rough' | 'clean'

export interface SelectionOverlay {
  ids: ObjectId[]
  /** World-space oriented bounds of the selection. */
  bounds?: Rect
  rotation?: number
  showHandles: boolean
  /** Rubber-band rectangle (world) or lasso polygon (world) while selecting. */
  marquee?: Rect
  lasso?: Vec2[]
  /** Object currently hovered as an arrow-binding target. */
  bindingTargetId?: ObjectId
}

export interface Scene {
  page: Page
  /** Visible objects (viewport-culled by the editor), sorted by z; superseded objects excluded. */
  objects: CanvasObject[]
  /** Lookup for resolving arrow bindings (may include off-screen objects). */
  resolve: (id: ObjectId) => CanvasObject | undefined
  selection?: SelectionOverlay
  /** Ids of objects hidden during an interaction (e.g. text being edited in DOM). */
  hiddenIds?: Set<ObjectId>
  /** Ephemeral preview objects (shape/arrow being dragged). */
  previews?: CanvasObject[]
  /** Search hit highlight rects (world). */
  highlights?: Rect[]
  theme: VisualTheme
}

/** Retained-scene renderer. Implementations: WebGLRenderer (default), Canvas2DRenderer (fallback/export). */
export interface Renderer {
  render(scene: Scene, camera: Camera): void
  resize(viewport: Size): void
  /** Drop cached GPU/geometry data for objects (after they changed or were deleted). */
  invalidate(ids?: Iterable<ObjectId>): void
  dispose(): void
}

/** Immediate-mode Canvas2D layer for the stroke currently being drawn (Pencil hot path). */
export interface LiveInkLayer {
  begin(style: StrokeStyle): void
  /** Append samples (world coordinates) and draw them immediately. */
  append(points: InkPoint[], camera: Camera): void
  /** Redraw the whole live stroke (e.g. after camera change). */
  redraw(camera: Camera): void
  clear(): void
  resize(viewport: Size): void
  dispose(): void
}

export interface ArrowGeometry {
  start: Vec2
  end: Vec2
}

export type ResolveArrow = (arrow: ArrowObject, resolve: (id: ObjectId) => CanvasObject | undefined) => ArrowGeometry
