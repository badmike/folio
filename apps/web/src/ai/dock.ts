/**
 * State of the AI dock on a notebook screen: open and width, server config and credit, the thread list,
 * and one AiSession per opened thread (a thread keeps running while another one is shown).
 */
import { computed, ref, shallowRef, type InjectionKey, type ShallowRef } from 'vue'
import type { NotebookController } from '../notebook'
import type { AuthService } from '../services/auth'
import { diagnostics } from '../services/diagnostics'
import type { Workspace } from '../services/workspace'
import { AiApi, AiApiError, aiDisabledReason } from './api'
import { createAppHost } from './app-host'
import type { ContextBuilder, CreateToolRunner, RevertEffects } from './host'
import type { AiConfigRes, AiCredit, AiPreset, ThreadSummary } from './protocol'
import { AiSession, type BaseHost } from './session'

export const DOCK_MIN = 340
export const DOCK_MAX = 640
/** Below this window width the dock overlays the canvas instead of pushing it. */
export const DOCK_PUSH_MIN_WINDOW = 1100

const WIDTH_KEY = 'folio.ai.dockWidth'
const PRESET_KEY = 'folio.ai.preset'
const threadKey = (nb: string) => `folio.ai.thread.${nb}`

function lsGet(k: string): string | null { try { return localStorage.getItem(k) } catch { return null } }
function lsSet(k: string, v: string | null) {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* ignore */ }
}
export const clampDockWidth = (w: number) => Math.round(Math.min(DOCK_MAX, Math.max(DOCK_MIN, w)))

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
/** A fractional order key strictly between `a` and `b` (null = open end). Keys never end in '0'. */
export function keyBetween(a: string | null, b: string | null): string {
  const lo = a ?? ''
  let out = ''
  for (let i = 0; ; i++) {
    const da = i < lo.length ? DIGITS.indexOf(lo[i]) : 0
    const db = b !== null && i < b.length ? DIGITS.indexOf(b[i]) : DIGITS.length
    if (da === db) { out += DIGITS[da]; continue }
    const mid = Math.floor((da + db) / 2)
    if (mid > da) return out + DIGITS[mid]
    // adjacent digits: keep a's digit and go one level deeper with no upper bound
    return out + DIGITS[da] + keyBetween(lo.slice(i + 1), null)
  }
}

export interface DockTools {
  createToolRunner: CreateToolRunner
  revertEffects: RevertEffects
  contextBuilder: ContextBuilder
}

export class AiDock {
  readonly open = ref(false)
  readonly view = ref<'thread' | 'threads'>('thread')
  readonly width = ref(clampDockWidth(Number(lsGet(WIDTH_KEY)) || 400))
  readonly config = shallowRef<AiConfigRes | null>(null)
  readonly credit = shallowRef<AiCredit | null>(null)
  readonly configError = ref<string | null>(null)
  readonly presetId = ref(lsGet(PRESET_KEY) ?? '')
  readonly threads = shallowRef<ThreadSummary[]>([])
  readonly settled = shallowRef<ThreadSummary[]>([])
  readonly showSettled = ref(false)
  readonly search = ref('')
  readonly listLoading = ref(false)
  /** The thread shown in the dock; a draft until its first message. */
  readonly session: ShallowRef<AiSession>

  readonly disabledReason = computed(() => aiDisabledReason(this.auth) ?? this.configError.value)
  readonly preset = computed<AiPreset | null>(() => {
    const c = this.config.value
    return c?.presets.find((p) => p.id === this.presetId.value) ?? c?.presets.find((p) => p.id === c.defaultPresetId) ?? null
  })

  readonly host: BaseHost
  private readonly sessions = new Map<string, AiSession>()
  private listSeq = 0

  constructor(
    readonly api: AiApi,
    private readonly ws: Workspace,
    private readonly auth: Pick<AuthService, 'signedIn' | 'online'>,
    private readonly ctl: NotebookController,
    readonly tools: DockTools,
  ) {
    this.host = createAppHost(ws, () => this.ctl)
    this.session = shallowRef(this.draft())
  }

  get notebookId(): string { return this.ctl.id }

  toggle(): void { this.setOpen(!this.open.value) }
  setOpen(v: boolean): void {
    this.open.value = v
    if (v) void this.activate()
  }

  setWidth(w: number, persist = true): void {
    this.width.value = clampDockWidth(w)
    if (persist) lsSet(WIDTH_KEY, String(this.width.value))
  }

  setPreset(id: string): void {
    this.presetId.value = id
    lsSet(PRESET_KEY, id)
  }

  /** First open: config and credit, then the last thread of this notebook. */
  private async activate(): Promise<void> {
    if (aiDisabledReason(this.auth)) return
    if (!this.config.value) await this.loadConfig()
    const last = lsGet(threadKey(this.notebookId))
    if (last && !this.session.value.id) {
      await this.openThread(last).catch(() => lsSet(threadKey(this.notebookId), null))
    }
  }

  async loadConfig(): Promise<void> {
    try {
      const c = await this.api.config()
      this.config.value = c
      this.credit.value = c.credit
      this.configError.value = null
    } catch (e) {
      this.configError.value = e instanceof AiApiError && e.code === 'ai_not_configured' ? e.message : null
      if (!(e instanceof AiApiError)) diagnostics.log('ai.config', e)
    }
  }

  private draft(thread: ThreadSummary | null = null): AiSession {
    const tools = this.tools
    return new AiSession({
      api: this.api,
      host: this.host,
      createRunner: tools.createToolRunner,
      revertEffects: tools.revertEffects,
      environment: (h) => tools.contextBuilder.environment(h),
      deviceId: this.ws.deviceId,
      notebookId: this.ctl.id,
      presetId: () => this.preset.value?.id ?? this.presetId.value,
      onCredit: (c) => { this.credit.value = c },
      onThread: (t) => this.onThread(t),
    }, thread)
  }

  private onThread(t: ThreadSummary): void {
    const s = this.session.value
    if (s.id === t.id && !this.sessions.has(t.id)) this.sessions.set(t.id, s)
    lsSet(threadKey(this.notebookId), t.id)
    const known = this.threads.value.some((x) => x.id === t.id)
    this.threads.value = known ? this.threads.value.map((x) => (x.id === t.id ? t : x)) : [t, ...this.threads.value]
  }

  newThread(): void {
    const cur = this.session.value
    if (!cur.id && !cur.busy.value) cur.dispose()
    this.session.value = this.draft()
    this.view.value = 'thread'
    lsSet(threadKey(this.notebookId), null)
  }

  async openThread(id: string): Promise<void> {
    const cur = this.session.value
    if (!cur.id && !cur.busy.value && cur !== this.sessions.get(id)) cur.dispose()
    let s = this.sessions.get(id)
    if (!s) {
      const known = [...this.threads.value, ...this.settled.value].find((t) => t.id === id)
      s = this.draft(known ?? { id, notebookId: this.ctl.id, title: '', pinKey: null, settledAt: null, lastActivityAt: 0, createdAt: 0, status: 'idle' })
      this.sessions.set(id, s)
    }
    this.session.value = s
    this.view.value = 'thread'
    lsSet(threadKey(this.notebookId), id)
    if (s.busy.value) return
    try {
      await s.load()
    } catch (e) {
      this.sessions.delete(id)
      if (this.session.value === s) this.newThread()
      throw e
    }
  }

  async refreshThreads(): Promise<void> {
    if (this.disabledReason.value) return
    const seq = ++this.listSeq
    this.listLoading.value = true
    try {
      const q = { notebookId: this.ctl.id, search: this.search.value }
      const [active, settled] = await Promise.all([
        this.api.threads({ ...q, settled: false }),
        this.showSettled.value || this.search.value.trim() ? this.api.threads({ ...q, settled: true }) : Promise.resolve(this.settled.value),
      ])
      if (seq !== this.listSeq) return
      this.threads.value = active
      this.settled.value = settled
    } finally {
      if (seq === this.listSeq) this.listLoading.value = false
    }
  }

  async rename(t: ThreadSummary, title: string): Promise<void> {
    this.replace(await this.api.updateThread(t.id, { title }))
  }

  async togglePin(t: ThreadSummary): Promise<void> {
    const firstKey = this.threads.value.map((x) => x.pinKey).filter((k): k is string => !!k).sort()[0] ?? null
    this.replace(await this.api.updateThread(t.id, { pinKey: t.pinKey ? null : keyBetween(null, firstKey) }))
    await this.refreshThreads()
  }

  async toggleSettled(t: ThreadSummary): Promise<void> {
    this.replace(await this.api.updateThread(t.id, { settled: !t.settledAt }))
    await this.refreshThreads()
  }

  async remove(t: ThreadSummary): Promise<void> {
    await this.api.deleteThread(t.id)
    this.sessions.get(t.id)?.dispose()
    this.sessions.delete(t.id)
    this.threads.value = this.threads.value.filter((x) => x.id !== t.id)
    this.settled.value = this.settled.value.filter((x) => x.id !== t.id)
    if (this.session.value.id === t.id) this.newThread()
  }

  private replace(t: ThreadSummary): void {
    const swap = (l: ThreadSummary[]) => l.map((x) => (x.id === t.id ? t : x))
    this.threads.value = swap(this.threads.value)
    this.settled.value = swap(this.settled.value)
    const s = this.sessions.get(t.id)
    if (s) s.thread.value = t
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.dispose()
    this.session.value.dispose()
    this.sessions.clear()
  }
}

/** Provided by the notebook screen to the dock components. */
export const AI_DOCK_KEY: InjectionKey<AiDock> = Symbol('ai-dock')
