/**
 * Seam between the tool executors (`./tools/`) and the app (`./session.ts` and the dock UI).
 * The app implements ToolHost; the tools only talk to the notebook through it, so they stay testable
 * against an in-memory document.
 */
import type { NotebookDocumentApi, NotebookId, ObjectId, Operation, PageId, Rect } from '@folio/document'
import type { SearchHit } from '@folio/persistence'
import type { ContextChip, Environment, ToolCall, ToolEffect, ToolResult } from './protocol'

/** What the user is looking at. null in the library view. */
export interface HostView {
  notebookId: NotebookId
  pageId: PageId
  viewport: Rect
  selection: ObjectId[]
}

export interface ApprovalRequest {
  kind: 'delete_page' | 'other_notebook'
  notebookId: NotebookId
  /** Plain sentence shown in the approval bar, e.g. "Delete page 3 'Eigenvectors'". */
  summary: string
}

/** 'thread' means "Allow for this thread" (only offered for 'other_notebook'). */
export type ApprovalDecision = 'once' | 'thread' | 'deny'

export interface AskUserInput {
  question: string
  options: { label: string; description?: string }[]
  allowFreeText: boolean
}

export type AskUserAnswer = { option: string } | { text: string } | { dismissed: true }

export interface ToolHost {
  view(): HostView | null
  /** Every notebook in the library, for library threads. */
  notebooks(): Promise<{ id: NotebookId; title: string; tags: string[] }[]>
  /**
   * Live document of an open notebook, or a temporarily opened session for any other notebook.
   * The session stays open until `fn` settles; tools call `apply` and `highlight` from inside it.
   */
  withNotebook<T>(id: NotebookId, fn: (doc: NotebookDocumentApi) => T | Promise<T>): Promise<T>
  /**
   * Apply one tool's operations. Routes through the editor when it shows that page, so the whole
   * turn is one undo step (grouped by `turnId`); otherwise applies to the session directly.
   */
  apply(notebookId: NotebookId, ops: Operation[], turnId: string): void
  search(query: string, limit?: number): Promise<SearchHit[]>
  /** Base64 PNG of a page region (whole content bounds when omitted), at most 1568px on the long side. */
  render(notebookId: NotebookId, pageId: PageId, region?: Rect): Promise<string>
  /** Asset metadata for insert_image; undefined when the asset is unknown. */
  asset(assetId: string): Promise<{ mimeType: string; width: number; height: number } | undefined>
  approve(req: ApprovalRequest): Promise<ApprovalDecision>
  ask(input: AskUserInput): Promise<AskUserAnswer>
  /** Briefly highlight objects (glow) and, when `zoom`, bring them into view. */
  highlight(notebookId: NotebookId, pageId: PageId, ids: ObjectId[], zoom?: boolean): void
}

/** Implemented in `./tools/index.ts`. */
export interface ToolRunner {
  run(call: ToolCall, turnId: string): Promise<ToolResult>
}
export type CreateToolRunner = (host: ToolHost) => ToolRunner

export interface RevertReport {
  reverted: number
  /** Objects the user changed after the AI did; left as they are. */
  skipped: { kind: 'object' | 'page'; notebookId: NotebookId; pageId: PageId; id: ObjectId }[]
}
/** Implemented in `./tools/revert.ts`. Effects are passed newest first. */
export type RevertEffects = (host: ToolHost, effects: ToolEffect[]) => Promise<RevertReport>

/** Implemented in `./tools/context.ts`: the environment and chip contents the composer sends. */
export interface ContextBuilder {
  environment(host: ToolHost): Promise<Environment>
  selectionChip(host: ToolHost): Promise<ContextChip | null>
  pageChip(host: ToolHost): Promise<ContextChip | null>
  /** For @ mentions of pages, frames and notebooks. */
  mentionChip(host: ToolHost, ref: ContextChip['ref'], kind: ContextChip['kind']): Promise<ContextChip>
}
