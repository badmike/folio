import type { InkStroke } from '@folio/document'

/** Seeded PRNG (mulberry32) so synthetic tests are deterministic. */
export function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    /** approx N(0,1) */
    gauss: () => {
      let s = 0
      for (let i = 0; i < 6; i++) s += next()
      return (s - 3) * 1.4142
    },
  }
}

let counter = 0

export function makeStroke(
  pts: { x: number; y: number }[],
  o: { id?: string; startedAt?: number; dt?: number; color?: string; transform?: Partial<InkStroke['transform']> } = {},
): InkStroke {
  const dt = o.dt ?? 8
  const flat: number[] = []
  pts.forEach((p, i) => flat.push(p.x, p.y, 0.5, 0, 0, i * dt))
  return {
    id: o.id ?? `s${++counter}`,
    type: 'ink',
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, ...o.transform },
    z: 0,
    createdAt: 0,
    updatedAt: 0,
    points: flat,
    style: { tool: 'pen', color: o.color ?? '#1e1e1e', width: 2, opacity: 1, pressureSensitive: true },
    startedAt: o.startedAt ?? 0,
    pointerType: 'pen',
  }
}

export function polyline(vertices: { x: number; y: number }[], closed: boolean, step = 3): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  const n = vertices.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % n]
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    const k = Math.max(1, Math.round(d / step))
    for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k })
  }
  if (!closed) out.push({ ...vertices[n - 1] })
  return out
}
