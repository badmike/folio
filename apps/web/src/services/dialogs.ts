import { shallowRef } from 'vue'

export type DialogRequest =
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; danger: boolean; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; title: string; label: string; value: string; confirmLabel: string; resolve: (v: string | null) => void }
  | { kind: 'choose'; title: string; options: { value: string; label: string; depth?: number }[]; resolve: (v: string | null) => void }

/** The dialog currently shown by DialogHost (one at a time; further requests queue). */
export const dialog = shallowRef<DialogRequest | null>(null)
const queue: DialogRequest[] = []

function push(req: DialogRequest) {
  if (dialog.value) queue.push(req)
  else dialog.value = req
}

/** Called by DialogHost when the current dialog was answered. */
export function closeDialog(): void {
  dialog.value = queue.shift() ?? null
}

export function confirmDialog(o: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) =>
    push({ kind: 'confirm', title: o.title, message: o.message ?? '', confirmLabel: o.confirmLabel ?? 'OK', danger: !!o.danger, resolve }))
}

export function promptDialog(o: { title: string; label?: string; value?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) =>
    push({ kind: 'prompt', title: o.title, label: o.label ?? '', value: o.value ?? '', confirmLabel: o.confirmLabel ?? 'Save', resolve }))
}

export function chooseDialog(o: { title: string; options: { value: string; label: string; depth?: number }[] }): Promise<string | null> {
  return new Promise((resolve) => push({ kind: 'choose', title: o.title, options: o.options, resolve }))
}
