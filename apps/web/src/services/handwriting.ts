import type { Storage } from '@folio/persistence'
import { emptyProfile, sanitizeProfile, type HandwritingProfile } from '@folio/recognition'
import { shallowRef, triggerRef, watch } from 'vue'

const KEY = 'handwriting'

/** What folio learned about the user's handwriting on this device. Change it with `updateHandwriting`. */
export const handwriting = shallowRef<HandwritingProfile>(emptyProfile())

/** Change the profile in place and notify watchers (recognition, persistence). */
export function updateHandwriting(change: (p: HandwritingProfile) => void): void {
  change(handwriting.value)
  triggerRef(handwriting)
}

export function resetHandwriting(): void {
  handwriting.value = emptyProfile()
}

/** Load the profile from storage and persist future changes. Returns a stop function. */
export async function bindHandwriting(storage: Storage): Promise<() => void> {
  handwriting.value = sanitizeProfile(await storage.getSetting<unknown>(KEY))
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = watch(handwriting, (p) => {
    clearTimeout(timer)
    timer = setTimeout(() => { void storage.setSetting(KEY, p) }, 500)
  })
  return () => { stop(); clearTimeout(timer) }
}
