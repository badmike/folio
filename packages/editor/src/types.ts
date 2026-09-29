import type {
  CanvasObject, DocChangeEvent, FontFamily, InkStroke, NotebookDocumentApi, ObjectId, Operation, PageId, Rect, ShapeKind,
  ShapeObject, ArrowObject, TextObject, StrokeStyle,
} from '@folio/document'
import type { Camera, LiveInkLayer, Renderer, VisualTheme } from '@folio/renderer'

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'select' | 'shape' | 'arrow' | 'text'
export type PenMode = 'auto' | 'pen-only' | 'any'
export type SelectMode = 'auto' | 'rect' | 'lasso'

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
  }
  arrow: {
    strokeColor: string
    strokeWidth: number
    opacity: number
    roughness: number
    startHead: 'none' | 'arrow'
    endHead: 'none' | 'arrow'
  }
  text: { fontSize: number; fontFamily: FontFamily; color: string }
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
