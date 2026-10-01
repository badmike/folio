import { StorageLockedError, openStorage, type Storage } from '@folio/persistence'
import { shallowRef, ref, watch, type ShallowRef } from 'vue'
import { AuthService } from './services/auth'
import { diagnostics } from './services/diagnostics'
import { RecognitionService } from './services/recognition'
import { thumbnailDataUrl } from './services/export'
import { bindSettings, settings } from './services/settings'
import { loadRuntimeConfig, runtimeConfig } from './services/runtime-config'
import { SyncService } from './services/sync'
import { Workspace } from './services/workspace'

export type BootState = 'booting' | 'ready' | 'locked' | 'error'

export interface AppServices {
  storage: Storage
  storageKind: Storage['kind']
  workspace: Workspace
  auth: AuthService
  sync: SyncService
  recognition: RecognitionService
}

/** Boot progress, shown by App.vue. */
export const bootState = ref<BootState>('booting')
export const bootError = ref('')
/** Set once boot() succeeded. Service objects are never made deeply reactive. */
export const services: ShallowRef<AppServices | null> = shallowRef(null)

export function requireServices(): AppServices {
  if (!services.value) throw new Error('folio is not booted yet')
  return services.value
}

/** Assemble the app services around a storage (also used by tests with MemoryStorage). */
export async function createServices(storage: Storage): Promise<AppServices> {
  await bindSettings(storage)
  const workspace = await Workspace.open(storage, diagnostics)
  const auth = new AuthService()
  const sync = new SyncService(workspace, auth)
  const { apiBase } = runtimeConfig
  const recognition = new RecognitionService(
    apiBase ? { apiBase, getToken: () => auth.getToken(), isSignedIn: () => auth.signedIn.value } : undefined,
  )
  return { storage, storageKind: storage.kind, workspace, auth, sync, recognition }
}

async function makeWelcomeThumbnail(ws: Workspace, id: string): Promise<void> {
  try {
    const session = await ws.openNotebook(id)
    const url = await thumbnailDataUrl(session.doc, settings.theme)
    if (url) await ws.setThumbnail(id, url)
    await ws.release(id)
  } catch (e) {
    diagnostics.log('welcome.thumbnail', e)
  }
}

let booting: Promise<void> | null = null

/** Startup sequence: storage -> settings -> workspace -> first run -> auth/sync. */
export function boot(): Promise<void> {
  booting ??= (async () => {
    try {
      const [opened] = await Promise.all([openStorage({ diagnostics }), loadRuntimeConfig()])
      const s = await createServices(opened.storage)
      const welcome = await s.workspace.ensureFirstRun()
      services.value = s
      bootState.value = 'ready'
      if (welcome) void makeWelcomeThumbnail(s.workspace, welcome)
      void s.auth.load()
      s.sync.init()
      const flush = () => { void s.workspace.flushAll() }
      addEventListener('pagehide', flush)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
    } catch (e) {
      diagnostics.log('boot', e)
      if (e instanceof StorageLockedError) {
        bootState.value = 'locked'
      } else {
        bootError.value = e instanceof Error ? e.message : String(e)
        bootState.value = 'error'
      }
    }
  })()
  return booting
}

/** Resolves with the services once boot finished (rejects if boot failed). */
export function whenReady(): Promise<AppServices> {
  return new Promise((resolve, reject) => {
    const check = (s: BootState): boolean => {
      if (s === 'ready') resolve(requireServices())
      else if (s === 'locked' || s === 'error') reject(new Error(`boot ${s}`))
      else return false
      return true
    }
    if (check(bootState.value)) return
    const stop = watch(bootState, (s) => { if (check(s)) stop() })
  })
}
