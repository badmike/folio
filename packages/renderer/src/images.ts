export type ImageSource = ImageBitmap | HTMLImageElement
export type ImageResolver = (assetId: string) => Promise<ImageSource | null>

interface Entry {
  status: 'loading' | 'ready' | 'missing'
  image: ImageSource | null
}

/** Async image cache shared by the renderers. */
export class ImageCache {
  private entries = new Map<string, Entry>()
  private resolver: ImageResolver | null = null
  /** Called when an image becomes available so the host can re-render. */
  onReady: (() => void) | null = null

  setResolver(r: ImageResolver | null): void {
    this.resolver = r
    // retry previously missing assets with the new resolver
    for (const [k, e] of this.entries) if (e.status === 'missing') this.entries.delete(k)
  }

  /** Returns the image if loaded (starting a load otherwise). */
  get(assetId: string): ImageSource | null {
    const e = this.entries.get(assetId)
    if (e) return e.image
    if (!this.resolver) return null
    const entry: Entry = { status: 'loading', image: null }
    this.entries.set(assetId, entry)
    this.resolver(assetId).then(
      (img) => {
        if (this.entries.get(assetId) !== entry) return
        entry.image = img
        entry.status = img ? 'ready' : 'missing'
        if (img) this.onReady?.()
      },
      () => {
        entry.status = 'missing'
      },
    )
    return null
  }

  drop(assetId: string): void {
    this.entries.delete(assetId)
  }

  clear(): void {
    this.entries.clear()
  }
}
