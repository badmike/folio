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

export function isIosSafariNotInstalled(): boolean {
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches
  return ios && !standalone
}
