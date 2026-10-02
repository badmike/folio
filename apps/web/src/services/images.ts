import { createId } from '@folio/document'
import type { ImageResolver, ImageSource } from '@folio/renderer'
import type { Workspace } from './workspace'

/** Largest image file accepted (the sync server's asset limit). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/** Image types every supported browser decodes. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp'])

export function isImageFile(file: File): boolean {
  return IMAGE_TYPES.has(file.type)
}

/** Decode image bytes. SVG goes through an <img>, which `createImageBitmap` cannot take everywhere. */
async function decode(blob: Blob): Promise<ImageSource> {
  if (blob.type !== 'image/svg+xml' && typeof createImageBitmap === 'function') return createImageBitmap(blob)
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Loads image objects' assets from the workspace store for the renderers. */
export function assetImageResolver(ws: Workspace): ImageResolver {
  return async (assetId) => {
    const a = await ws.storage.getAsset(assetId)
    if (!a) return null
    return decode(new Blob([a.bytes as BlobPart], { type: a.mimeType }))
  }
}

/** Store an image file as an asset; returns what the editor needs to place it. */
export async function storeImageFile(ws: Workspace, file: File): Promise<{ assetId: string; mimeType: string; width: number; height: number }> {
  if (!isImageFile(file)) throw new Error(`${file.name || 'This file'} is not a supported image.`)
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name || 'The image'} is larger than 25 MB.`)
  const img = await decode(file)
  const width = img.width, height = img.height
  if ('close' in img) img.close()
  const assetId = createId()
  await ws.storage.putAsset(assetId, new Uint8Array(await file.arrayBuffer()), file.type)
  return { assetId, mimeType: file.type, width, height }
}

/** Ask the user for image files (system file picker). */
export function pickImageFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = [...IMAGE_TYPES].join(',')
    input.multiple = true
    input.addEventListener('change', () => resolve([...(input.files ?? [])]))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}
