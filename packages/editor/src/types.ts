import type {
  ArrowType, Arrowhead, BlurMode, CanvasObject, DocChangeEvent, FillStyle, FontFamily, HighlighterCap, InkStroke, StrokeLineStyle, NotebookDocumentApi, ObjectId, Operation, PageId, Rect, Roundness, ShapeKind,
  ShapeObject, ArrowObject, TextObject, StrokeStyle,
} from '@folio/document'
import type { Camera, LiveInkLayer, Renderer, VisualTheme } from '@folio/renderer'

/** 'hand' pans with any pointer; 'frame' and 'blur' draw the corresponding box shapes. */
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'select' | 'hand' | 'shape' | 'arrow' | 'text' | 'frame' | 'blur'

/** Tools that create one object and then hand back to the selection tool unless the tool lock is on. */
export const ONE_SHOT_TOOLS: readonly Tool[] = ['shape', 'arrow', 'text', 'frame', 'blur']

export type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'

/** Stroke / background colour remembered per one-shot tool. */
export type ToolColors = Partial<Record<Tool, { strokeColor: string; backgroundColor: string }>>
export type DistributeAxis = 'horizontal' | 'vertical'
export type PenMode = 'auto' | 'pen-only' | 'any'
export type SelectMode = 'auto' | 'rect' | 'lasso'
/** What a marquee or lasso selects: objects touching it, or only objects fully inside it. */
export type SelectionMode = 'overlap' | 'wrap'

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
  hand: Record<never, never>
  frame: Record<never, never>
  blur: Record<never, never>
  note: Record<never, never>
  counter: Record<never, never>
  shape: {
    kind: ShapeKind
    strokeColor: string
    strokeWidth: number
    fillColor?: string
    opacity: number
    roughness: number
    fillStyle?: FillStyle
    strokeStyle?: StrokeLineStyle
    roundness?: Roundness
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
  /** Keep one-shot tools (shape, arrow, text, frame, blur) active after creating an object. Default false. */
  toolLock?: boolean
  /** Scribbling over ink with the pen erases it. Default true. */
  scribbleErase?: boolean
  /** Default 'overlap'. */
  selectionMode?: SelectionMode
  /** Snap moves, resizes and new shapes to other objects' edges and centres. Default false. */
  snapToObjects?: boolean
  /** Snap moves, resizes and new shapes to the page grid. Default false. */
  snapToGrid?: boolean
  /**
   * Text pasted from the system clipboard. Return true when handled (e.g. Excalidraw JSON was
   * converted and inserted); otherwise the editor inserts it as a text object.
   */
  onPasteText?: (text: string) => boolean | Promise<boolean>
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
  toollock: boolean
  readonly: boolean
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
  /** Corner style of new rectangles / triangles / diamonds. */
  roundness: Roundness
  /** Block size / radius of new blur masks (world units). */
  blurSize: number
  blurMode: BlurMode
  /** Outline of new counters. */
  counterStyle: CounterStyle
}

/** 'cap' is the highlighter end shape; it lives in the highlighter tool options, not in ItemStyle. */
export type StyleProp = keyof ItemStyle | 'cap'
/** Patch applied by setStyle(); `cap` only affects highlighter strokes / the highlighter tool. */
export type StylePatch = Partial<ItemStyle> & { cap?: HighlighterCap }

/**
 * What the properties panel should show for the current context (selection if
 * non-empty, else the active tool). `values[p]` is the common value or 'mixed'.
 */
export interface StyleContext {
  source: 'selection' | 'tool'
  /** Properties that make sense for the selected object types / active tool. */
  applicable: StyleProp[]
  values: { [K in keyof ItemStyle]?: ItemStyle[K] | 'mixed' } & { cap?: HighlighterCap | 'mixed' }
  /** Selected object types (empty when source === 'tool'). */
  types: CanvasObject['type'][]
  /** Page background colour — the panel previews swatches adapted to it. */
  canvasBackground: string
}
