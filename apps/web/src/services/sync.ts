import { SyncApi, SyncEngine, type SyncStatus } from '@folio/sync'
import { ref, shallowRef, watch } from 'vue'
import type { AuthService } from './auth'
import { diagnostics } from './diagnostics'
import { runtimeConfig } from './runtime-config'
import { WORKSPACE_DOC_ID, type Workspace } from './workspace'

export type SyncUiState = SyncStatus['state'] | 'local'

/**
 * Wires the sync engine to the workspace: only runs when a server is configured and the
 * user is signed in (Clerk, or a dev token for local testing).
 */
export class SyncService {
  readonly status = shallowRef<SyncStatus>({ state: 'idle', lastSyncedAt: null, pending: 0 })
  /** 'local' = sync is not active (no server / not signed in). */
  readonly uiState = ref<SyncUiState>('local')
  private engine: SyncEngine | null = null
  private stopSub: (() => void) | null = null
  private stopLocal: (() => void) | null = null

  constructor(private readonly ws: Workspace, private readonly auth: AuthService) {}

  get available(): boolean { return !!runtimeConfig.apiBase }

  /** Start/stop automatically as the account signs in/out. */
  init(): () => void {
    const stop = watch(() => this.auth.signedIn.value, (signedIn) => {
      if (signedIn) void this.start()
      else this.stop()
    }, { immediate: true })
    return () => { stop(); this.stop() }
  }

  private async start(): Promise<void> {
    const apiBase = runtimeConfig.apiBase
    if (!apiBase || this.engine) return
    const ws = this.ws
    const api = new SyncApi({ baseUrl: apiBase, getToken: () => this.auth.getToken() })
    const engine = new SyncEngine({
      api,
      storage: ws.storage,
      deviceId: ws.deviceId,
      openDoc: async (docId) => (docId === WORKSPACE_DOC_ID ? ws.doc : (await ws.openForSync(docId)).doc),
      // Remote updates must be durable locally before the pulled sequence advances.
      beforeCommitPulled: (docId) => ws.flushDoc(docId),
      onRemoteDoc: () => { /* the workspace doc's own 'remote' event refreshes the library */ },
      logger: { warn: (...a) => diagnostics.log('sync.warn', a.map(String).join(' ')), error: (...a) => diagnostics.log('sync.error', a.map(String).join(' ')) },
    })
    this.engine = engine
    this.stopSub = engine.subscribe((s) => {
      this.status.value = s
      this.uiState.value = s.state
    })
    this.stopLocal = ws.onLocalChange((docId) => engine.notifyLocalChange(docId))
    await this.registerDevice(api)
    if (this.engine === engine) engine.start()
  }

  private async registerDevice(api: SyncApi): Promise<void> {
    const key = `deviceRegistered:${this.ws.deviceId}`
    try {
      if (await this.ws.storage.getSetting<boolean>(key)) return
      await api.registerDevice(this.ws.deviceId, deviceName())
      await this.ws.storage.setSetting(key, true)
    } catch (e) {
      diagnostics.log('sync.registerDevice', e) // retried on next start
    }
  }

  syncNow(): void {
    void this.engine?.syncAll().catch(() => { /* status shows the error */ })
  }

  stop(): void {
    this.engine?.stop()
    this.stopSub?.()
    this.stopLocal?.()
    this.engine = null
    this.stopSub = this.stopLocal = null
    this.uiState.value = 'local'
  }
}

function deviceName(): string {
  const ua = navigator.userAgent
  const os = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device'
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'browser'
  return `${os} ${br}`
}
