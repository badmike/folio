import type { CanvasObject, InkStroke, Recognition } from '@folio/document'
import type { Editor } from '@folio/editor'
import {
  AUTO_CLEANUP_MIN_CONFIDENCE, WebHandwritingRecognizer, createRecognitionCoordinator, planCleanup,
  type CleanupProposal, type RecognitionCoordinator,
} from '@folio/recognition'
import { ref, shallowRef } from 'vue'
import { diagnostics } from './diagnostics'
import { settings } from './settings'
import type { NotebookSession } from './workspace'

const IDLE_MS = 2500
const REGION_PAD = 160
/** Minimum confidence for the manual "Clean Up" button. */
export const MANUAL_CLEANUP_CONFIDENCE = 0.5

export interface CleanupPrompt {
  count: number
  apply(): void
  dismiss(): void
}

export interface CloudHooks {
  apiBase: string
  getToken: () => Promise<string | null>
  isSignedIn: () => boolean
}

const isLiveInk = (o: CanvasObject | undefined): o is InkStroke => !!o && o.type === 'ink' && !o.supersededBy

/**
 * Background handwriting/shape recognition and Clean Up, decoupled from the UI.
 * One coordinator (and one recognition worker) is shared by the whole app.
 */
export class RecognitionService {
  /** Non-modal "Clean up N items?" prompt (cleanup mode 'ask'). */
  readonly prompt = shallowRef<CleanupPrompt | null>(null)
  /** Number of recognition jobs currently running. */
  readonly busy = ref(0)
  private coordinator: RecognitionCoordinator | null = null
  private readonly pageOwners = new Map<string, NotebookSession>()

  constructor(private readonly cloud?: CloudHooks) {}

  private getCoordinator(): RecognitionCoordinator {
    if (!this.coordinator) {
      const cloud = this.cloud
      this.coordinator = createRecognitionCoordinator({
        recognizerConfig: { tesseractBaseUrl: '/tesseract/', languages: [...settings.languages] },
        // The W3C Handwriting Recognition API is unavailable in workers, so it runs here.
        mainThreadRecognizer: new WebHandwritingRecognizer(),
        cloud: cloud
          ? {
              apiBase: cloud.apiBase,
              getToken: cloud.getToken,
              enabled: () => settings.cloudRefinement && cloud.isSignedIn() && (typeof navigator === 'undefined' || navigator.onLine !== false),
            }
          : undefined,
        onRefined: (pageId, recs) => this.storeRecognitions(this.pageOwners.get(pageId), pageId, recs),
      })
    }
    return this.coordinator
  }

  /** Attach to a mounted editor. Call `detach()` when the editor is destroyed. */
  attach(editor: Editor, session: NotebookSession): AttachedRecognition {
    return new AttachedRecognition(this, editor, session)
  }

  /** @internal */
  recognize(session: NotebookSession, pageId: string, strokes: InkStroke[], now: boolean): Promise<Recognition[]> {
    this.pageOwners.set(pageId, session)
    const req = { pageId, strokes, languages: [...settings.languages] }
    const c = this.getCoordinator()
    this.busy.value++
    const p = now ? c.recognizeNow(req) : c.enqueue(req)
    return p.finally(() => { this.busy.value-- })
  }

  /**
   * Store recognitions (non-undoable) and drop stale ones whose strokes were regrouped.
   * Ink itself is never touched.
   */
  storeRecognitions(session: NotebookSession | undefined, pageId: string, recs: Recognition[]): void {
    if (!session || !session.doc.page(pageId)) return
    const doc = session.doc
    const existing = doc.recognitions(pageId)
    const byId = new Map(existing.map((r) => [r.id, r]))
    const fresh = recs.filter((r) => {
      if (!r.strokeIds.every((id) => doc.object(pageId, id))) return false // strokes were deleted meanwhile
      const prev = byId.get(r.id)
      return !prev || prev.text !== r.text || prev.refinedText !== r.refinedText || prev.shape !== r.shape || prev.confidence !== r.confidence
    })
    const covered = new Set(recs.flatMap((r) => r.strokeIds))
    const newIds = new Set(recs.map((r) => r.id))
    // A recognition is stale once regrouping fully covers its strokes with newer results.
    const stale = existing.filter((e) => !newIds.has(e.id) && e.strokeIds.every((s) => covered.has(s))).map((e) => e.id)
    const ops = []
    if (stale.length) ops.push({ type: 'deleteRecognitions' as const, pageId, ids: stale })
    if (fresh.length) ops.push({ type: 'setRecognitions' as const, pageId, recognitions: fresh })
    session.apply(ops)
  }

  dispose(): void {
    this.coordinator?.dispose()
    this.coordinator = null
  }
}

export class AttachedRecognition {
  private readonly since = Date.now()
  private pointerDown = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private promptTimer: ReturnType<typeof setTimeout> | undefined
  private readonly inflight = new Set<Promise<unknown>>()
  /** Recognitions we already auto-converted / offered (so undo is not fought). */
  private readonly attempted = new Set<string>()
  /** Strokes the user restored: never auto-clean them again. */
  private readonly noAuto = new Set<string>()
  private detached = false
  private readonly onDown = () => { this.pointerDown++ }
  private readonly onUp = () => { this.pointerDown = Math.max(0, this.pointerDown - 1); this.armIdle() }

  constructor(
    private readonly svc: RecognitionService,
    private readonly editor: Editor,
    private readonly session: NotebookSession,
  ) {
    const r = editor.root
    r.addEventListener('pointerdown', this.onDown, true)
    r.addEventListener('pointerup', this.onUp, true)
    r.addEventListener('pointercancel', this.onUp, true)
  }

  /** Pass to createEditor({ onStrokeCommitted }). */
  onStrokeCommitted = (pageId: string, stroke: InkStroke): void => {
    if (this.detached) return
    this.svc.prompt.value = null
    const strokes = this.nearbyInk(pageId, stroke)
    const p = this.svc.recognize(this.session, pageId, strokes, false)
      .then((recs) => { if (!this.detached) this.svc.storeRecognitions(this.session, pageId, recs) })
      .catch((e) => diagnostics.log('recognition.enqueue', e))
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
    this.armIdle()
  }

  private nearbyInk(pageId: string, stroke: InkStroke): InkStroke[] {
    let candidates: CanvasObject[]
    // region query around the new stroke (editor spatial index) when it is the visible page
    const sb = strokeBounds(stroke)
    if (this.editor.pageId === pageId) {
      candidates = this.editor.queryRect({ x: sb.x - REGION_PAD, y: sb.y - REGION_PAD, width: sb.width + REGION_PAD * 2, height: sb.height + REGION_PAD * 2 })
    } else {
      candidates = this.session.doc.objects(pageId)
    }
    const found = new Map<string, InkStroke>()
    for (const o of candidates) if (isLiveInk(o)) found.set(o.id, o)
    found.set(stroke.id, stroke)
    // Regrouping must see whole existing groups (a word/line is usually wider than the region),
    // otherwise a partial re-recognition would replace a good full-line result.
    for (let pass = 0; pass < 3; pass++) {
      let grew = false
      for (const r of this.session.doc.recognitions(pageId)) {
        if (!r.strokeIds.some((id) => found.has(id))) continue
        for (const id of r.strokeIds) {
          if (found.has(id)) continue
          const o = this.session.doc.object(pageId, id)
          if (isLiveInk(o)) { found.set(id, o); grew = true }
        }
      }
      if (!grew) break
    }
    const out = [...found.values()]
    return out
  }

  // --- auto cleanup ---------------------------------------------------------

  private armIdle(): void {
    clearTimeout(this.idleTimer)
    if (this.detached || settings.cleanupMode === 'keep') return
    this.idleTimer = setTimeout(() => void this.onIdle(), IDLE_MS)
  }

  private async onIdle(): Promise<void> {
    if (this.detached || settings.cleanupMode === 'keep') return
    if (this.pointerDown > 0 || this.editor.isEditingText) return this.armIdle()
    await Promise.allSettled([...this.inflight])
    if (this.detached || this.pointerDown > 0) return
    const plans = this.plan(AUTO_CLEANUP_MIN_CONFIDENCE, true)
    if (!plans.length) return
    for (const p of plans) this.attempted.add(p.recognitionId)
    if (settings.cleanupMode === 'auto') {
      this.editor.applyCleanup(plans)
    } else {
      const count = plans.length
      const dismiss = () => { clearTimeout(this.promptTimer); this.svc.prompt.value = null }
      this.svc.prompt.value = {
        count,
        apply: () => { dismiss(); this.editor.applyCleanup(plans) },
        dismiss,
      }
      clearTimeout(this.promptTimer)
      this.promptTimer = setTimeout(dismiss, 12_000)
    }
  }

  private plan(minConfidence: number, auto: boolean): CleanupProposal[] {
    const pageId = this.editor.pageId
    const doc = this.session.doc
    const strokes = doc.objects(pageId).filter(isLiveInk)
    const live = new Set(strokes.map((s) => s.id))
    const recs = doc.recognitions(pageId).filter((r) => {
      if (!r.strokeIds.every((id) => live.has(id))) return false
      if (!auto) return true
      return r.createdAt >= this.since && !this.attempted.has(r.id) && !r.strokeIds.some((id) => this.noAuto.has(id))
    })
    return planCleanup(strokes, recs, { minConfidence })
  }

  // --- manual actions -------------------------------------------------------

  selectedInk(): InkStroke[] {
    return this.editor.leavesOf(this.editor.selection).filter(isLiveInk)
  }

  /** Recognize the selected strokes and convert them. Returns the number of created objects. */
  async cleanUpSelection(): Promise<number> {
    const strokes = this.selectedInk()
    if (!strokes.length) return 0
    const pageId = this.editor.pageId
    const recs = await this.svc.recognize(this.session, pageId, strokes, true)
    if (this.detached) return 0
    this.svc.storeRecognitions(this.session, pageId, recs)
    const plans = planCleanup(strokes, recs, { minConfidence: MANUAL_CLEANUP_CONFIDENCE })
    for (const p of plans) this.attempted.add(p.recognitionId)
    const ids = this.editor.applyCleanup(plans)
    if (ids.length) this.editor.select(ids)
    return ids.length
  }

  /** True if the selection contains derived (cleaned-up) objects or their superseded source ink. */
  selectionHasDerived(): boolean {
    return this.editor.leavesOf(this.editor.selection).some((o) => 'sourceStrokeIds' in o && !!o.sourceStrokeIds?.length)
  }

  restoreSelection(): void {
    const sel = this.editor.leavesOf(this.editor.selection)
    for (const o of sel) if ('sourceStrokeIds' in o) for (const id of o.sourceStrokeIds ?? []) this.noAuto.add(id)
    this.editor.restoreInk(sel.map((o) => o.id))
  }

  /** Recognized/typed text of the selection, top-to-bottom, for the clipboard. */
  selectionText(): string {
    const leaves = this.editor.leavesOf(this.editor.selection)
    const parts: { y: number; text: string }[] = []
    const ink = new Set(leaves.filter((o) => o.type === 'ink').map((o) => o.id))
    const covered = new Set<string>()
    for (const o of leaves) {
      if (o.type === 'text' && o.text.trim()) parts.push({ y: o.transform.y, text: o.text })
      else if ((o.type === 'shape' || o.type === 'arrow') && o.label) parts.push({ y: o.type === 'shape' ? o.transform.y : o.start.y, text: o.label })
    }
    for (const r of this.session.doc.recognitions(this.editor.pageId)) {
      if (r.kind !== 'text') continue
      const t = r.refinedText ?? r.text
      if (t && r.strokeIds.some((id) => ink.has(id)) && !r.strokeIds.some((id) => covered.has(id))) {
        r.strokeIds.forEach((id) => covered.add(id))
        parts.push({ y: r.bounds.y, text: t })
      }
    }
    return parts.sort((a, b) => a.y - b.y).map((p) => p.text).join('\n')
  }

  detach(): void {
    this.detached = true
    clearTimeout(this.idleTimer)
    clearTimeout(this.promptTimer)
    this.svc.prompt.value = null
    const r = this.editor.root
    r.removeEventListener('pointerdown', this.onDown, true)
    r.removeEventListener('pointerup', this.onUp, true)
    r.removeEventListener('pointercancel', this.onUp, true)
  }
}

function strokeBounds(s: InkStroke): { x: number; y: number; width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const t = s.transform
  for (let i = 0; i < s.points.length; i += 6) {
    const x = t.x + s.points[i] * t.scaleX
    const y = t.y + s.points[i + 1] * t.scaleY
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!isFinite(minX)) return { x: t.x, y: t.y, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
