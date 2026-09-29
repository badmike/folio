import RBush from 'rbush'
import type { ObjectId, Rect } from '@folio/document'

interface Item {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: ObjectId
}

/** rbush wrapper keyed by object id (world-space AABBs). */
export class SpatialIndex {
  private tree = new RBush<Item>()
  private items = new Map<ObjectId, Item>()

  get size(): number {
    return this.items.size
  }

  clear(): void {
    this.tree.clear()
    this.items.clear()
  }

  has(id: ObjectId): boolean {
    return this.items.has(id)
  }

  /** Replace the whole index (bulk load is much faster than inserts). */
  load(entries: Iterable<[ObjectId, Rect]>): void {
    this.clear()
    const list: Item[] = []
    for (const [id, r] of entries) {
      const item = { minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height, id }
      this.items.set(id, item)
      list.push(item)
    }
    this.tree.load(list)
  }

  /** Insert/update (rect) or remove (null). */
  set(id: ObjectId, r: Rect | null): void {
    const old = this.items.get(id)
    if (old) {
      this.tree.remove(old)
      this.items.delete(id)
    }
    if (!r) return
    const item = { minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height, id }
    this.items.set(id, item)
    this.tree.insert(item)
  }

  /** Ids whose bounds intersect `r`. */
  search(r: Rect): ObjectId[] {
    const found = this.tree.search({ minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height })
    const out = new Array<ObjectId>(found.length)
    for (let i = 0; i < found.length; i++) out[i] = found[i].id
    return out
  }

  all(): ObjectId[] {
    return [...this.items.keys()]
  }
}
