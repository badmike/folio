import { ref } from 'vue'
import { registerSW } from 'virtual:pwa-register'

/** True once the service worker has precached the app for offline use. */
export const offlineReady = ref(false)

export function initPwa(): void {
  if (!('serviceWorker' in navigator)) return
  registerSW({
    immediate: true,
    onOfflineReady() { offlineReady.value = true },
  })
  // Already installed in an earlier session -> immediately "ready".
  void navigator.serviceWorker.ready.then((reg) => { if (reg.active) offlineReady.value = true }).catch(() => {})
}

/**
 * Checks for a new release and reloads. Installed web apps on iPad have no browser reload button.
 * When an update is found, registerSW reloads once it activates; offline, this just reloads.
 */
export async function refreshApp(): Promise<void> {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
  await reg?.update().catch(() => {})
  const next = reg?.installing ?? reg?.waiting
  if (!next) return location.reload()
  next.addEventListener('statechange', () => { if (next.state === 'redundant') location.reload() })
}

export function isIosSafariNotInstalled(): boolean {
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches
  return ios && !standalone
}
