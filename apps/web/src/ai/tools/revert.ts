/**
 * Revert AI effects, newest first, without undoing the user's work.
 *
 * Detection: from each effect's forward ops we derive the state they left behind: added objects and
 * pages exactly as added, patched fields at their patched values (including the `updatedAt` stamp the
 * AI wrote, which every editor change bumps), deleted things absent. Before applying an inverse we
 * compare that with the live document. Objects that differ were touched by the user (or someone
 * else) afterwards: their part of the inverse is dropped and they are reported. Pages and notebook
 * meta revert field by field, so a later rename by the user survives. Because effects run newest
 * first, an object the AI changed twice is compared against the older op only after the newer op was
 * undone, and a skip there carries to the older op too (its state no longer matches either).
 */
import { createId, type NotebookDocumentApi, type Operation, type PageId } from '@folio/document'
import type { RevertEffects, RevertReport } from '../host'
import type { ToolEffect } from '../protocol'

interface Expected {
  present: boolean
  /** Added: the whole value must match. Patched: only `fields` and `absent`. */
  exact: boolean
  fields: Record<string, unknown>
  absent: Set<string>
}

const record = (o: object): Record<string, unknown> => Object.fromEntries(Object.entries(o))

/** Structural equality that ignores undefined properties (they are dropped when stored). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))
  }
  const ra = record(a), rb = record(b)
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)])
  return [...keys].every((k) => same(ra[k], rb[k]))
}

function patched(prev: Expected | undefined, patch: object): Expected {
  const e: Expected = prev?.present ? prev : { present: true, exact: false, fields: {}, absent: new Set() }
  for (const [k, v] of Object.entries(patch)) {
    if (k === '$unset') continue
    if (v === undefined) {
      delete e.fields[k]
      e.absent.add(k)
    } else {
      e.fields[k] = v
      e.absent.delete(k)
    }
  }
  const unset: unknown = Reflect.get(patch, '$unset')
  if (Array.isArray(unset)) for (const k of unset) if (typeof k === 'string') { delete e.fields[k]; e.absent.add(k) }
  return e
}

const added = (value: object): Expected => ({ present: true, exact: true, fields: record(value), absent: new Set() })
const gone: Expected = { present: false, exact: true, fields: {}, absent: new Set() }
const objKey = (pageId: PageId, id: string) => `${pageId}:${id}`

/** The state the forward ops left behind, per object, page and the notebook meta. */
function expectations(ops: Operation[]) {
  const objects = new Map<string, { pageId: PageId; id: string; e: Expected }>()
  const pages = new Map<PageId, Expected>()
  let meta: Expected | undefined
  const setObj = (pageId: PageId, id: string, e: Expected) => objects.set(objKey(pageId, id), { pageId, id, e })
  for (const op of ops) {
    switch (op.type) {
      case 'addObjects': op.objects.forEach((o) => setObj(op.pageId, o.id, added(o))); break
      case 'updateObjects': op.patches.forEach((p) => setObj(op.pageId, p.id, patched(objects.get(objKey(op.pageId, p.id))?.e, p.patch))); break
      case 'deleteObjects': op.ids.forEach((id) => setObj(op.pageId, id, gone)); break
      case 'addPage': pages.set(op.page.id, added(op.page)); break
      case 'updatePage': pages.set(op.pageId, patched(pages.get(op.pageId), op.patch)); break
      case 'deletePage': pages.set(op.pageId, gone); break
      case 'updateMeta': meta = patched(meta, op.patch); break
      case 'setRecognitions':
      case 'deleteRecognitions': break
    }
  }
  return { objects, pages, meta }
}

function matches(cur: object | undefined, e: Expected): boolean {
  if (!e.present || !cur) return !e.present && !cur
  if (e.exact) return same(cur, e.fields)
  const r = record(cur)
  return Object.entries(e.fields).every(([k, v]) => same(r[k], v)) && [...e.absent].every((k) => r[k] === undefined)
}

/** Fields of a patch expectation the user has changed since. */
function changedFields(cur: object, e: Expected): Set<string> {
  const r = record(cur)
  const out = new Set<string>()
  for (const [k, v] of Object.entries(e.fields)) if (!same(r[k], v)) out.add(k)
  for (const k of e.absent) if (r[k] !== undefined) out.add(k)
  return out
}

/** The patch without `drop` (also from its `$unset`), or null when nothing is left. */
function without<P extends object>(patch: P, drop: ReadonlySet<string> | undefined): P | null {
  const out = { ...patch }
  for (const k of drop ?? []) Reflect.deleteProperty(out, k)
  const unset: unknown = Reflect.get(out, '$unset')
  if (Array.isArray(unset)) {
    const rest = unset.filter((k) => !drop?.has(k))
    if (rest.length) Reflect.set(out, '$unset', rest)
    else Reflect.deleteProperty(out, '$unset')
  }
  return Object.keys(out).length ? out : null
}

function plan(doc: NotebookDocumentApi, effect: ToolEffect) {
  const exp = expectations(effect.ops)
  const skipped: RevertReport['skipped'] = []
  const skipObjects = new Set<string>()
  /** Pages whose existence changed since: every op on them is dropped. */
  const skipPages = new Set<PageId>()
  const pageFields = new Map<PageId, Set<string>>()

  for (const [pageId, e] of exp.pages) {
    const cur = doc.page(pageId)
    if (e.exact || !e.present) {
      // an added page with content the user put there stays
      if (!matches(cur, e) || (e.present && doc.objects(pageId).length)) {
        skipPages.add(pageId)
        skipped.push({ notebookId: effect.notebookId, pageId, id: pageId })
      }
    } else if (!cur) skipPages.add(pageId)
    else pageFields.set(pageId, changedFields(cur, e))
  }
  for (const [k, { pageId, id, e }] of exp.objects) {
    const pageMissing = !doc.page(pageId) && exp.pages.get(pageId)?.present !== false
    if (skipPages.has(pageId) || pageMissing || !matches(doc.object(pageId, id), e)) {
      skipObjects.add(k)
      skipped.push({ notebookId: effect.notebookId, pageId, id })
    }
  }
  const meta = doc.meta()
  const metaFields = exp.meta ? changedFields(meta, exp.meta) : undefined

  const ops = effect.inverse.flatMap((op): Operation[] => {
    switch (op.type) {
      case 'addObjects': {
        const objects = op.objects.filter((o) => !skipObjects.has(objKey(op.pageId, o.id)))
        return objects.length && !skipPages.has(op.pageId) ? [{ ...op, objects }] : []
      }
      case 'deleteObjects': {
        const ids = op.ids.filter((id) => !skipObjects.has(objKey(op.pageId, id)))
        return ids.length && !skipPages.has(op.pageId) ? [{ ...op, ids }] : []
      }
      case 'updateObjects': {
        const patches = op.patches.filter((p) => !skipObjects.has(objKey(op.pageId, p.id)))
        return patches.length && !skipPages.has(op.pageId) ? [{ ...op, patches }] : []
      }
      case 'updatePage': {
        const patch = skipPages.has(op.pageId) ? null : without(op.patch, pageFields.get(op.pageId))
        return patch ? [{ ...op, patch }] : []
      }
      case 'updateMeta': {
        const patch = without(op.patch, metaFields)
        return patch ? [{ ...op, patch }] : []
      }
      case 'addPage': return skipPages.has(op.page.id) ? [] : [op]
      case 'deletePage':
      case 'setRecognitions':
      case 'deleteRecognitions': return skipPages.has(op.pageId) ? [] : [op]
    }
  })
  return { ops, skipped, reverted: countTargets(ops) }
}

/** Distinct objects, pages and the meta an op list changes. */
function countTargets(ops: Operation[]): number {
  const keys = new Set<string>()
  for (const op of ops) {
    switch (op.type) {
      case 'addObjects': op.objects.forEach((o) => keys.add(objKey(op.pageId, o.id))); break
      case 'deleteObjects': op.ids.forEach((id) => keys.add(objKey(op.pageId, id))); break
      case 'updateObjects': op.patches.forEach((p) => keys.add(objKey(op.pageId, p.id))); break
      case 'addPage': keys.add(op.page.id); break
      case 'updatePage':
      case 'deletePage': keys.add(op.pageId); break
      case 'updateMeta': keys.add('meta'); break
      case 'setRecognitions':
      case 'deleteRecognitions': break
    }
  }
  return keys.size
}

export const revertEffects: RevertEffects = async (host, effects) => {
  const turnId = `revert-${createId()}`
  const report: RevertReport = { reverted: 0, skipped: [] }
  const seen = new Set<string>()
  for (const effect of effects) {
    await host.withNotebook(effect.notebookId, (doc) => {
      const { ops, skipped, reverted } = plan(doc, effect)
      if (ops.length) host.apply(effect.notebookId, ops, turnId)
      report.reverted += reverted
      for (const s of skipped) {
        const k = `${s.notebookId}:${s.pageId}:${s.id}`
        if (!seen.has(k)) report.skipped.push(s)
        seen.add(k)
      }
    })
  }
  return report
}
