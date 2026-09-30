import type {
  ArrowType, Arrowhead, CanvasObject, DocChangeEvent, FillStyle, FontFamily, InkStroke, StrokeLineStyle, NotebookDocumentApi, ObjectId, Operation, PageId, Rect, ShapeKind,
  ShapeObject, ArrowObject, TextObject, StrokeStyle,
} from '@folio/document'
import type { Camera, LiveInkLayer, Renderer, VisualTheme } from '@folio/renderer'

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'select' | 'shape' | 'arrow' | 'text'
export type PenMode = 'auto' | 'pen-only' | 'any'
export type SelectMode = 'auto' | 'rect' | 'lasso'

/**
 * NOTE: the shape / arrow / text entries are a read-only VIEW derived from
 * Editor.itemStyle (the single source of truth); setToolOptions() on those
 * tools is translated into an itemStyle patch.
 */
export interface ToolOptionsMap {
  pen: Omit<StrokeStyle, 'tool'>
  highlighter: Omit<StrokeStyle, 'tool'>
  /** Diameter in screen px. */
  eraser: { size: number }
  /** 'auto': lasso for the Pencil, rectangle otherwise. */
  select: { mode: SelectMode }
  shape: {
    kind: ShapeKind
    strokeColor: string
    strokeWidth: number
    fillColor?: string
    opacity: number
    roughness: number
    fillStyle?: FillStyle
    strokeStyle?: StrokeLineStyle
  }
  arrow: {
    strokeColor: string
    strokeWidth: number
    opacity: number
    roughness: number
    startHead: Arrowhead
    endHead: Arrowhead
    strokeStyle?: StrokeLineStyle
    arrowType?: ArrowType
  }
  text: { fontSize: number; fontFamily: FontFamily; color: string; align?: 'left' | 'center' | 'right'; opacity?: number }
}

export interface RendererFactoryOptions {
  canvas: HTMLCanvasElement
  kind?: 'webgl' | 'canvas2d'
  theme: VisualTheme
}

export interface EditorOptions {
  container: HTMLElement
  document: NotebookDocumentApi
  pageId: PageId
  renderer?: 'webgl' | 'canvas2d'
  theme?: VisualTheme
  /** Called after each local commit (incl. undo/redo) with the applied operations. */
  onOperations?: (ops: Operation[]) => void
  /** Called after a stroke was committed (after the frame that showed it). */
  onStrokeCommitted?: (pageId: PageId, stroke: InkStroke) => void
  readOnly?: boolean
  penMode?: PenMode
  /** Injection points (tests / alternative renderers). */
  rendererFactory?: (o: RendererFactoryOptions) => Renderer
  liveLayerFactory?: (canvas: HTMLCanvasElement) => LiveInkLayer
  initialTool?: Tool
}

export interface EditorEvents extends Record<string, unknown> {
  change: DocChangeEvent
  selection: ObjectId[]
  camera: Camera
  tool: Tool
  history: { canUndo: boolean; canRedo: boolean }
  textedit: { editing: boolean; id?: ObjectId }
  /** Style context changed (selection, tool, current item style or selected objects' style). */
  style: StyleContext
}

export interface ExecuteOptions {
  undoable?: boolean
  /** Consecutive commits with the same key (within ~1s) form one undo step. */
  coalesceKey?: string
}

/**
 * A recognised-ink to derived-object plan (compatible with the recognition
 * package's planCleanup output).
 */
export interface CleanupPlan {
  kind: 'text' | 'shape' | 'arrow'
  sourceStrokeIds: ObjectId[]
  object: Partial<Omit<TextObject, 'id' | 'z' | 'createdAt' | 'updatedAt'>> |
    Partial<Omit<ShapeObject, 'id' | 'z' | 'createdAt' | 'updatedAt'>> |
    Partial<Omit<ArrowObject, 'id' | 'z' | 'createdAt' | 'updatedAt'>>
}

export interface ClipboardPayload {
  kind: 'folio-clipboard'
  version: 1
  objects: CanvasObject[]
}

export interface ExportImageOptions {
  pageId?: PageId
  scale?: number
  bounds?: Rect
}

/** Style values that can be applied to a whole selection (see Editor.setSelectionStyle). */
export interface SelectionStylePatch {
  color?: string
  width?: number
  opacity?: number
}

// ---------------------------------------------------------------------------
// Excalidraw-style shared "current item" style + properties panel contract
// ---------------------------------------------------------------------------

/** Font size presets (world units) shown as S / M / L / XL. */
export const FONT_SIZE_PRESETS = { S: 16, M: 20, L: 28, XL: 36 } as const
/** Stroke width presets for shapes/arrows (thin / bold / extra bold). */
export const STROKE_WIDTH_PRESETS = [1, 2, 4] as const
/** Pen width presets (fine / medium / bold) and highlighter presets. */
export const PEN_WIDTH_PRESETS = [1.5, 2.5, 4.5] as const
export const HIGHLIGHTER_WIDTH_PRESETS = [12, 18, 28] as const

/**
 * The style used for NEW shapes/arrows/text (shared across those tools, like
 * Excalidraw's currentItem*). Pen & highlighter keep their own colour/width in
 * ToolOptionsMap because ink is usually drawn with a different pen than shapes.
 */
export interface ItemStyle {
  strokeColor: string
  /** 'transparent' = no fill */
  backgroundColor: string
  fillStyle: FillStyle
  strokeWidth: number
  strokeStyle: StrokeLineStyle
  /** 0 architect / 1 artist / 2 cartoonist */
  roughness: number
  /** 0..1 */
  opacity: number
  fontFamily: FontFamily
  fontSize: number
  textAlign: 'left' | 'center' | 'right'
  arrowType: ArrowType
  startHead: Arrowhead
  endHead: Arrowhead
}

export type StyleProp = keyof ItemStyle
/** Patch applied by setStyle(); also accepted: ink-only props for pen/highlighter. */
export type StylePatch = Partial<ItemStyle>

/**
 * What the properties panel should show for the current context (selection if
 * non-empty, else the active tool). `values[p]` is the common value or 'mixed'.
 */
export interface StyleContext {
  source: 'selection' | 'tool'
  /** Properties that make sense for the selected object types / active tool. */
  applicable: StyleProp[]
  values: { [K in StyleProp]?: ItemStyle[K] | 'mixed' }
  /** Selected object types (empty when source === 'tool'). */
  types: CanvasObject['type'][]
  /** Page background colour — the panel previews swatches adapted to it. */
  canvasBackground: string
}
