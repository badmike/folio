import { ref } from 'vue'

/**
 * Whether a physical keyboard is in use. Starts false on touch-only devices and flips to
 * true on the first real key press, so shortcut hints stay out of the way on an iPad
 * until a keyboard is attached.
 */
export const hasKeyboard = ref(typeof window === 'undefined' ? true : !window.matchMedia?.('(hover: none) and (pointer: coarse)').matches)

function onKey(e: KeyboardEvent) {
  if (hasKeyboard.value || e.isComposing) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  if (e.key.length === 1 || e.key.startsWith('Arrow') || e.key === 'Escape') hasKeyboard.value = true
}
if (typeof window !== 'undefined') window.addEventListener('keydown', onKey)
