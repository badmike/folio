import type { CanvasObject } from './types'

/** Deep clone of plain JSON-ish data; drops `undefined` object properties. */
export function cloneJson<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) {
    const out = new Array(v.length)
    for (let i = 0; i < v.length; i++) out[i] = cloneJson(v[i])
    return out as T
  }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object)) {
    const x = (v as Record<string, unknown>)[k]
    if (x !== undefined) out[k] = cloneJson(x)
  }
  return out as T
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/** Deterministic paint order: z, then createdAt, then id (so all peers agree). */
export function compareObjects(a: CanvasObject, b: CanvasObject): number {
  return a.z - b.z || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export interface Patch {
  /** Fields to set (already cloned). */
  set: Record<string, unknown>
  /** Fields to remove. */
  unset: string[]
}

/**
 * Compute the effective change of applying `patch` to `prev` (record-like), ignoring
 * `ignore` keys. Explicit `undefined` values and `$unset` entries remove fields; unset
 * wins over set. Returns the resulting record, the effective write set and the inverse
 * patch (which uses `$unset` for fields that were absent). `null` when nothing changes.
 */
export function computePatch<T extends object>(
  prev: T,
  patch: object,
  ignore: readonly string[],
): { next: T; write: Patch; inverse: Record<string, unknown> } | null {
  const p = patch as Record<string, unknown>
  const prevRec = prev as Record<string, unknown>
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  const unsetRequested = new Set<string>(Array.isArray(p.$unset) ? (p.$unset as string[]) : [])
  for (const k of Object.keys(p)) {
    if (k === '$unset' || ignore.includes(k)) continue
    if (p[k] === undefined) unsetRequested.add(k)
    else if (!unsetRequested.has(k)) set[k] = p[k]
  }
  const inverse: Record<string, unknown> = {}
  const invUnset: string[] = []
  const next: Record<string, unknown> = { ...prevRec }
  const writeSet: Record<string, unknown> = {}
  for (const k of Object.keys(set)) {
    if (ignore.includes(k)) continue
    if (k in prevRec && deepEqual(prevRec[k], set[k])) continue
    if (k in prevRec) inverse[k] = cloneJson(prevRec[k])
    else invUnset.push(k)
    writeSet[k] = next[k] = cloneJson(set[k])
  }
  for (const k of unsetRequested) {
    if (ignore.includes(k) || !(k in prevRec) || prevRec[k] === undefined) continue
    if (!(k in inverse)) inverse[k] = cloneJson(prevRec[k])
    delete next[k]
    unset.push(k)
  }
  if (Object.keys(writeSet).length === 0 && unset.length === 0) return null
  if (invUnset.length) inverse.$unset = invUnset
  return { next: next as T, write: { set: writeSet, unset }, inverse }
}
