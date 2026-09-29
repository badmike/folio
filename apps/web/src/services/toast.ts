import { shallowRef } from 'vue'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error' | 'success'
  actionLabel?: string
  action?: () => void
}

export const toasts = shallowRef<Toast[]>([])
let nextId = 1

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

export function toast(message: string, opts: { kind?: Toast['kind']; actionLabel?: string; action?: () => void; ms?: number } = {}): number {
  const t: Toast = { id: nextId++, message, kind: opts.kind ?? 'info', actionLabel: opts.actionLabel, action: opts.action }
  toasts.value = [...toasts.value.slice(-3), t]
  setTimeout(() => dismissToast(t.id), opts.ms ?? (opts.action ? 8000 : 3500))
  return t.id
}

export const toastError = (message: string) => toast(message, { kind: 'error', ms: 6000 })
