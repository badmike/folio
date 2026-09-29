/** Tiny typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>()

  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(cb as (payload: never) => void)
    return () => {
      set!.delete(cb as (payload: never) => void)
    }
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const cb of [...set]) (cb as (payload: Events[K]) => void)(payload)
  }

  clear(): void {
    this.listeners.clear()
  }
}
