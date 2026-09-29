/**
 * folio semantic document model — the shared contract between editor, renderer,
 * recognition, persistence and sync.
 *
 * The visible canvas is NOT the database. These types describe semantic objects
 * independently of how they are rendered.
 */

export type ObjectId = string
export type PageId = string
export type NotebookId = string
export type FolderId = string
/** Milliseconds since epoch. */
export type Timestamp = number

export interface Vec2 {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Object transform. Geometry stored on an object is in the object's LOCAL space;
 * world = translate(x,y) · rotate(rotation) · scale(scaleX,scaleY) · local.
 * Moving/rotating/scaling only rewrites the transform, never ink points.
 */
export interface Transform {
  x: number
  y: number
  /** radians */
  rotation: number
  scaleX: number
  scaleY: number
}

export type ObjectType = 'ink' | 'text' | 'shape' | 'arrow' | 'image' | 'group'

export interface BaseObject {
  id: ObjectId
  type: ObjectType
  transform: Transform
  /** Paint order within a page; higher paints later. Fractional values allowed. */
  z: number
  createdAt: Timestamp
  updatedAt: Timestamp
  /** Group membership (id of a GroupObject). */
  groupId?: ObjectId
  /**
   * Non-destructive cleanup: when ink is converted into text/shape the source
   * strokes are kept but marked as superseded by the derived object and are not
   * rendered. Removing this field (undo / "restore ink") brings them back.
   */
  supersededBy?: ObjectId
  /** Optional concept links to other objects/pages/notebooks. */
  links?: SemanticLink[]
}

export interface SemanticLink {
  notebookId: NotebookId
  pageId?: PageId
  objectId?: ObjectId
  label?: string
}

// ---------------------------------------------------------------------------
// Ink
// ---------------------------------------------------------------------------

/**
 * Flat point encoding: [x, y, pressure, tiltX, tiltY, t, x, y, ...].
 * x/y are local coordinates, pressure 0..1, tilt in degrees, t = ms offset from
 * stroke start. Stride = INK_POINT_STRIDE.
 */
export const INK_POINT_STRIDE = 6

export interface InkPoint {
  x: number
  y: number
  pressure: number
  tiltX: number
  tiltY: number
  t: number
}

export type InkTool = 'pen' | 'highlighter'

export interface StrokeStyle {
  tool: InkTool
  /** CSS color, e.g. '#1e1e1e' */
  color: string
  /** Base width in world units. */
  width: number
  /** 0..1 */
  opacity: number
  pressureSensitive: boolean
}

export interface InkStroke extends BaseObject {
  type: 'ink'
  /** Flat, immutable once committed. See INK_POINT_STRIDE. */
  points: number[]
  style: StrokeStyle
  /** Absolute start time of the stroke (ms since epoch). */
  startedAt: Timestamp
  /** Pointer type that produced the stroke. */
  pointerType: 'pen' | 'touch' | 'mouse'
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export type FontFamily = 'hand' | 'sans' | 'mono'
export type SemanticTextType = 'heading' | 'paragraph' | 'list-item' | 'label' | 'equation'

export interface TextObject extends BaseObject {
  type: 'text'
  text: string
  fontSize: number
  fontFamily: FontFamily
  color: string
  /** Wrap width in local units; undefined = no wrapping. */
  width?: number
  align?: 'left' | 'center' | 'right'
  semanticType?: SemanticTextType
  /** Ink strokes this text was derived from (Clean Up). */
  sourceStrokeIds?: ObjectId[]
}

// ---------------------------------------------------------------------------
// Shapes & arrows
// ---------------------------------------------------------------------------

export type ShapeKind = 'rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'line'

export interface ShapeStyle {
  strokeColor: string
  strokeWidth: number
  fillColor?: string
  opacity: number
  /** 0 = clean geometric, 1..3 = hand-drawn (rough) intensity. */
  roughness: number
  /** Deterministic seed so rough rendering is stable across frames/devices. */
  seed: number
}

/** Shape geometry: local box from (0,0) to (width,height). */
export interface ShapeObject extends BaseObject {
  type: 'shape'
  kind: ShapeKind
  width: number
  height: number
  style: ShapeStyle
  /** Optional text label rendered centered inside the shape. */
  label?: string
  sourceStrokeIds?: ObjectId[]
}

export interface ArrowBinding {
  objectId: ObjectId
  /** Normalised anchor within the target's local bounds (0..1); default center. */
  anchor?: Vec2
}

/**
 * Arrows are semantic connections. start/end are WORLD coordinates used when
 * unbound; when bound, renderers/editors resolve the endpoint from the bound
 * object's bounds (edge intersection towards the other endpoint), so moving
 * the target automatically updates the arrow. transform is identity for arrows.
 */
export interface ArrowObject extends BaseObject {
  type: 'arrow'
  start: Vec2
  end: Vec2
  startBinding?: ArrowBinding
  endBinding?: ArrowBinding
  style: ShapeStyle
  startHead: 'none' | 'arrow'
  endHead: 'none' | 'arrow'
  label?: string
  sourceStrokeIds?: ObjectId[]
}

// ---------------------------------------------------------------------------
// Images & groups
// ---------------------------------------------------------------------------

export interface ImageObject extends BaseObject {
  type: 'image'
  /** Asset id; bytes live in the asset store (OPFS/IDB locally, S3 remotely). */
  assetId: string
  mimeType: string
  width: number
  height: number
}

export interface GroupObject extends BaseObject {
  type: 'group'
  childIds: ObjectId[]
}

export type CanvasObject =
  | InkStroke
  | TextObject
  | ShapeObject
  | ArrowObject
  | ImageObject
  | GroupObject

/** Patch applied to an object; `type` and `id` are immutable. */
export type ObjectPatch = Partial<Omit<InkStroke, 'id' | 'type' | 'points'>> &
  Partial<Omit<TextObject, 'id' | 'type'>> &
  Partial<Omit<ShapeObject, 'id' | 'type'>> &
  Partial<Omit<ArrowObject, 'id' | 'type'>> &
  Partial<Omit<ImageObject, 'id' | 'type'>> &
  Partial<Omit<GroupObject, 'id' | 'type'>> & {
    /** Explicitly clear optional fields (e.g. 'supersededBy', 'groupId'). */
    $unset?: string[]
  }

// ---------------------------------------------------------------------------
// Recognition (semantic interpretation of ink)
// ---------------------------------------------------------------------------

export type RecognitionKind = 'text' | 'shape'

/**
 * Machine-readable interpretation of a group of strokes. Stored alongside the
 * original ink; never replaces it. Visible representation (cleanup) is separate.
 */
export interface Recognition {
  id: string
  kind: RecognitionKind
  strokeIds: ObjectId[]
  /** World-space bounds of the grouped strokes. */
  bounds: Rect
  /** For kind=text. */
  text?: string
  /** Cloud-refined machine text (does not rewrite visible content). */
  refinedText?: string
  /** For kind=shape. */
  shape?: ShapeKind | 'arrow'
  confidence: number
  language?: string
  semanticType?: SemanticTextType
  /** e.g. 'tesseract@7', 'web-handwriting', 'cloud', 'shape@1' */
  recognizer: string
  alternatives?: string[]
  createdAt: Timestamp
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export type PageKind = 'infinite' | 'fixed'
export type PageFormat = 'A4' | 'Letter' | 'iPad' | 'Custom'

/** Page sizes in world units (1 unit = 1 CSS px at zoom 1; A4 ≈ 96dpi). */
export const PAGE_FORMATS: Record<Exclude<PageFormat, 'Custom'>, { width: number; height: number }> = {
  A4: { width: 794, height: 1123 },
  Letter: { width: 816, height: 1056 },
  iPad: { width: 820, height: 1180 },
}

export type BackgroundPattern = 'blank' | 'ruled' | 'grid' | 'dot'

export interface PageBackground {
  pattern: BackgroundPattern
  /** Line/dot spacing in world units. */
  spacing: number
  /** 0..1 opacity of pattern lines. */
  opacity: number
  /** Page fill color. */
  color: string
  /** Pattern line/dot color. */
  lineColor: string
}

export interface Page {
  id: PageId
  title: string
  kind: PageKind
  format?: PageFormat
  /** Required for fixed pages. */
  width?: number
  height?: number
  background: PageBackground
  /** Fractional ordering within the notebook. */
  order: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ---------------------------------------------------------------------------
// Notebook & workspace
// ---------------------------------------------------------------------------

export interface ToolSettings {
  pen: StrokeStyle
  highlighter: StrokeStyle
  shape: ShapeStyle
  eraserSize: number
}

export interface NotebookMeta {
  id: NotebookId
  title: string
  tags: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
  toolSettings?: ToolSettings
}

export interface FolderEntry {
  id: FolderId
  name: string
  parentId: FolderId | null
  createdAt: Timestamp
  updatedAt: Timestamp
  deleted?: boolean
}

/** Workspace-level index entry for a notebook (lives in the workspace doc). */
export interface NotebookEntry {
  id: NotebookId
  title: string
  folderId: FolderId | null
  tags: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
  deleted?: boolean
}

// ---------------------------------------------------------------------------
// Operations (application semantics; journal + undo/redo)
// ---------------------------------------------------------------------------

export type Operation =
  | { type: 'addObjects'; pageId: PageId; objects: CanvasObject[] }
  | { type: 'deleteObjects'; pageId: PageId; ids: ObjectId[] }
  | { type: 'updateObjects'; pageId: PageId; patches: { id: ObjectId; patch: ObjectPatch }[] }
  | { type: 'addPage'; page: Page }
  | { type: 'updatePage'; pageId: PageId; patch: Partial<Omit<Page, 'id'>> }
  | { type: 'deletePage'; pageId: PageId }
  | { type: 'setRecognitions'; pageId: PageId; recognitions: Recognition[] }
  | { type: 'deleteRecognitions'; pageId: PageId; ids: string[] }
  | { type: 'updateMeta'; patch: Partial<Omit<NotebookMeta, 'id'>> }

export type ChangeOrigin = 'local' | 'remote' | 'load' | 'journal'

export interface DocChangeEvent {
  origin: ChangeOrigin
  /** Pages whose objects/recognitions/properties changed. */
  pageIds: Set<PageId>
  /** Objects changed (added/updated/deleted) where known; undefined = unknown/all. */
  objectIds?: Set<ObjectId>
  pagesChanged: boolean
  metaChanged: boolean
}

export type Unsubscribe = () => void
