import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from 'fflate'
import { createId } from './factories'
import { NotebookDocument } from './notebook'
import type { NotebookDocumentApi } from './api'
import type { PageFormat, PageKind } from './types'

/** Current portable-format schema version. */
export const FOLIO_FORMAT_VERSION = 1
export const FOLIO_APP_ID = 'com.coderscantina.folio'

export interface FolioPageSummary {
  id: string
  title: string
  kind: PageKind
  format?: PageFormat
  width?: number
  height?: number
  order: number
  objectCount: number
}

export interface FolioAssetEntry {
  id: string
  mimeType: string
  size: number
  path: string
}

export interface FolioManifest {
  format: 'folio'
  version: number
  app: string
  notebookId: string
  title: string
  createdAt: number
  updatedAt: number
  pages: FolioPageSummary[]
  assets: FolioAssetEntry[]
  /** Path of the preview image inside the archive, when present. */
  preview?: string
}

export type AssetMap = Map<string, { bytes: Uint8Array; mimeType: string }>

/** Upgrade any supported older manifest to the current shape; rejects unknown/newer ones. */
export function migrateManifest(raw: unknown): FolioManifest {
  if (!raw || typeof raw !== 'object') throw new Error('folio: manifest is not an object')
  const m = { ...(raw as Record<string, unknown>) }
  if (m.format !== 'folio') throw new Error('folio: not a folio archive')
  let version = typeof m.version === 'number' ? m.version : NaN
  if (!Number.isInteger(version) || version < 1) throw new Error('folio: invalid manifest version')
  if (version > FOLIO_FORMAT_VERSION) {
    throw new Error(`folio: archive version ${version} is newer than supported (${FOLIO_FORMAT_VERSION})`)
  }
  // Future migrations: while (version < FOLIO_FORMAT_VERSION) { ...; version++ }
  m.version = version = FOLIO_FORMAT_VERSION
  for (const k of ['notebookId', 'title'] as const) {
    if (typeof m[k] !== 'string') throw new Error(`folio: manifest.${k} missing`)
  }
  m.app = typeof m.app === 'string' ? m.app : FOLIO_APP_ID
  m.createdAt = typeof m.createdAt === 'number' ? m.createdAt : 0
  m.updatedAt = typeof m.updatedAt === 'number' ? m.updatedAt : 0
  m.pages = Array.isArray(m.pages) ? m.pages : []
  m.assets = Array.isArray(m.assets) ? m.assets : []
  return m as unknown as FolioManifest
}

function isWebp(b: Uint8Array): boolean {
  return b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
}

/** Build a portable .folio zip: manifest.json + document.loro + assets/<id> [+ preview]. */
export function exportFolio(doc: NotebookDocumentApi, assets: AssetMap, preview?: Uint8Array): Uint8Array {
  const meta = doc.meta()
  const files: Zippable = {}
  const assetEntries: FolioAssetEntry[] = []
  for (const [id, a] of assets) {
    const path = `assets/${id}`
    files[path] = [a.bytes, { level: 0 }]
    assetEntries.push({ id, mimeType: a.mimeType, size: a.bytes.length, path })
  }
  let previewPath: string | undefined
  if (preview) {
    previewPath = isWebp(preview) ? 'preview.webp' : 'preview.png'
    files[previewPath] = [preview, { level: 0 }]
  }
  const manifest: FolioManifest = {
    format: 'folio',
    version: FOLIO_FORMAT_VERSION,
    app: FOLIO_APP_ID,
    notebookId: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pages: doc.pages().map((p) => ({
      id: p.id, title: p.title, kind: p.kind, format: p.format, width: p.width, height: p.height,
      order: p.order, objectCount: doc.objects(p.id).length,
    })),
    assets: assetEntries,
    ...(previewPath ? { preview: previewPath } : {}),
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  files['document.loro'] = [doc.exportSnapshot(), { level: 6 }]
  return zipSync(files)
}

export interface ImportFolioResult {
  doc: NotebookDocument
  assets: AssetMap
  manifest: FolioManifest
}

/** Parse + validate a .folio archive. With `newId` the notebook gets a fresh id (import as copy). */
export function importFolio(bytes: Uint8Array, opts: { newId?: boolean } = {}): ImportFolioResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch (e) {
    throw new Error(`folio: not a valid archive (${(e as Error).message})`)
  }
  const mf = files['manifest.json']
  if (!mf) throw new Error('folio: manifest.json missing')
  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(mf))
  } catch {
    throw new Error('folio: manifest.json is not valid JSON')
  }
  const manifest = migrateManifest(raw)
  const snapshot = files['document.loro']
  if (!snapshot) throw new Error('folio: document.loro missing')
  const doc = NotebookDocument.fromSnapshot(snapshot)
  if (!doc.meta().title && manifest.title) doc.apply([{ type: 'updateMeta', patch: { title: manifest.title } }])
  const assets: AssetMap = new Map()
  for (const a of manifest.assets) {
    const data = files[a.path ?? `assets/${a.id}`]
    if (!data) throw new Error(`folio: asset ${a.id} listed in manifest but missing`)
    assets.set(a.id, { bytes: data, mimeType: a.mimeType })
  }
  if (opts.newId) {
    const id = createId()
    doc.rekey(id)
    manifest.notebookId = id
  } else if (doc.id !== manifest.notebookId) {
    manifest.notebookId = doc.id
  }
  return { doc, assets, manifest }
}
