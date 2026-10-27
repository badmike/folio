/**
 * Graph layouts for draw_diagram, written by hand (no dependency). Every layout returns top-left
 * positions with the drawing's bounds starting at (0, 0), and never lets two nodes overlap.
 */
import type { Vec2 } from '@folio/document'

export const LAYOUTS = ['layered', 'tree', 'grid', 'radial'] as const
export type LayoutKind = (typeof LAYOUTS)[number]
export const DIRECTIONS = ['down', 'right'] as const
export type Direction = (typeof DIRECTIONS)[number]

export interface LayoutNode { key: string; width: number; height: number }
export interface LayoutEdge { from: string; to: string }
export interface Spacing {
  /** Between layers (layered, tree) and rings (radial). */
  rank: number
  /** Between neighbours in a layer, row or ring. */
  node: number
}

export function layoutGraph(
  kind: LayoutKind,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  direction: Direction = 'down',
  spacing: Spacing = { rank: 80, node: 48 },
): Map<string, Vec2> {
  const keys = new Set(nodes.map((n) => n.key))
  const links = edges.filter((e) => e.from !== e.to && keys.has(e.from) && keys.has(e.to))
  switch (kind) {
    case 'layered': return normalize(nodes, fromAxes(nodes, layersOf(nodes, links), direction, spacing))
    case 'tree': return normalize(nodes, tree(nodes, links, direction, spacing))
    case 'grid': return normalize(nodes, grid(nodes, direction, spacing))
    case 'radial': return normalize(nodes, radial(nodes, links, spacing))
  }
}

/** Shift positions so the union of node boxes starts at (0, 0). */
function normalize(nodes: LayoutNode[], pos: Map<string, Vec2>): Map<string, Vec2> {
  let x0 = Infinity, y0 = Infinity
  for (const n of nodes) {
    const p = pos.get(n.key)!
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
  }
  return new Map(nodes.map((n) => {
    const p = pos.get(n.key)!
    return [n.key, { x: p.x - x0, y: p.y - y0 }]
  }))
}

// ---------------------------------------------------------------------------
// layered (Sugiyama-lite)
// ---------------------------------------------------------------------------

/** Main axis = flow direction, cross axis = across it. */
const mainSize = (n: LayoutNode, d: Direction) => (d === 'down' ? n.height : n.width)
const crossSize = (n: LayoutNode, d: Direction) => (d === 'down' ? n.width : n.height)

/**
 * Layers of keys: cycles broken by reversing DFS back edges, layers by longest path from the
 * sources, order inside layers by alternating barycentre sweeps.
 */
function layersOf(nodes: LayoutNode[], edges: LayoutEdge[]): string[][] {
  const out = new Map(nodes.map((n) => [n.key, [] as string[]]))
  for (const e of edges) out.get(e.from)!.push(e.to)

  // DFS: drop edges back into the current path, which leaves a DAG
  const state = new Map<string, 'open' | 'done'>()
  const dag = new Map(nodes.map((n) => [n.key, [] as string[]]))
  const visit = (k: string) => {
    state.set(k, 'open')
    for (const t of out.get(k)!) {
      const s = state.get(t)
      if (s === 'open') dag.get(t)!.push(k)
      else {
        dag.get(k)!.push(t)
        if (!s) visit(t)
      }
    }
    state.set(k, 'done')
  }
  for (const n of nodes) if (!state.has(n.key)) visit(n.key)

  // longest path layering in topological order
  const indeg = new Map(nodes.map((n) => [n.key, 0]))
  for (const ts of dag.values()) for (const t of ts) indeg.set(t, indeg.get(t)! + 1)
  const rank = new Map(nodes.map((n) => [n.key, 0]))
  const queue = nodes.filter((n) => indeg.get(n.key) === 0).map((n) => n.key)
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]
    for (const t of dag.get(k)!) {
      rank.set(t, Math.max(rank.get(t)!, rank.get(k)! + 1))
      indeg.set(t, indeg.get(t)! - 1)
      if (indeg.get(t) === 0) queue.push(t)
    }
  }

  const layers: string[][] = []
  for (const n of nodes) (layers[rank.get(n.key)!] ??= []).push(n.key)
  const dense = layers.filter((l) => l?.length)

  const preds = new Map(nodes.map((n) => [n.key, [] as string[]]))
  for (const [k, ts] of dag) for (const t of ts) preds.get(t)!.push(k)
  const index = new Map<string, number>()
  const reindex = () => dense.forEach((l) => l.forEach((k, i) => index.set(k, i)))
  reindex()
  const sweep = (layer: string[], neighbours: (k: string) => string[]) => {
    const bary = new Map(layer.map((k, i) => {
      const ns = neighbours(k).filter((n) => index.has(n))
      return [k, ns.length ? ns.reduce((s, n) => s + index.get(n)!, 0) / ns.length : i]
    }))
    layer.sort((a, b) => bary.get(a)! - bary.get(b)!)
    layer.forEach((k, i) => index.set(k, i))
  }
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 1; i < dense.length; i++) sweep(dense[i], (k) => preds.get(k)!)
    for (let i = dense.length - 2; i >= 0; i--) sweep(dense[i], (k) => dag.get(k)!)
  }
  return dense
}

/** Layers to positions: each layer one band along the main axis, centred on the cross axis. */
function fromAxes(nodes: LayoutNode[], layers: string[][], d: Direction, sp: Spacing): Map<string, Vec2> {
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const pos = new Map<string, Vec2>()
  let main = 0
  for (const layer of layers) {
    const ns = layer.map((k) => byKey.get(k)!)
    const thick = Math.max(...ns.map((n) => mainSize(n, d)))
    const span = ns.reduce((s, n) => s + crossSize(n, d), 0) + sp.node * (ns.length - 1)
    let cross = -span / 2
    for (const n of ns) {
      const m = main + (thick - mainSize(n, d)) / 2
      pos.set(n.key, d === 'down' ? { x: cross, y: m } : { x: m, y: cross })
      cross += crossSize(n, d) + sp.node
    }
    main += thick + sp.rank
  }
  return pos
}

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

/** Tidy tree: a BFS spanning forest from the sources, each parent centred over its subtree. */
function tree(nodes: LayoutNode[], edges: LayoutEdge[], d: Direction, sp: Spacing): Map<string, Vec2> {
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const out = new Map(nodes.map((n) => [n.key, [] as string[]]))
  const hasParent = new Set<string>()
  for (const e of edges) {
    out.get(e.from)!.push(e.to)
    hasParent.add(e.to)
  }
  const children = new Map(nodes.map((n) => [n.key, [] as string[]]))
  const depth = new Map<string, number>()
  const roots: string[] = []
  const grow = (root: string) => {
    roots.push(root)
    depth.set(root, 0)
    const queue = [root]
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i]
      for (const c of out.get(k)!) {
        if (depth.has(c)) continue
        depth.set(c, depth.get(k)! + 1)
        children.get(k)!.push(c)
        queue.push(c)
      }
    }
  }
  for (const n of nodes) if (!hasParent.has(n.key) && !depth.has(n.key)) grow(n.key)
  for (const n of nodes) if (!depth.has(n.key)) grow(n.key) // cycles without a source

  const levels: number[] = []
  for (const [k, lv] of depth) levels[lv] = Math.max(levels[lv] ?? 0, mainSize(byKey.get(k)!, d))
  const offsets: number[] = []
  let acc = 0
  for (const [i, h] of levels.entries()) {
    offsets[i] = acc
    acc += h + sp.rank
  }

  const extent = new Map<string, number>()
  const measure = (k: string): number => {
    const cs = children.get(k)!
    const kids = cs.reduce((s, c) => s + measure(c), 0) + sp.node * Math.max(0, cs.length - 1)
    const e = Math.max(crossSize(byKey.get(k)!, d), kids)
    extent.set(k, e)
    return e
  }
  const pos = new Map<string, Vec2>()
  const place = (k: string, start: number) => {
    const n = byKey.get(k)!
    const e = extent.get(k)!
    const lv = depth.get(k)!
    const cross = start + (e - crossSize(n, d)) / 2
    const main = offsets[lv] + (levels[lv] - mainSize(n, d)) / 2
    pos.set(k, d === 'down' ? { x: cross, y: main } : { x: main, y: cross })
    const cs = children.get(k)!
    const kids = cs.reduce((s, c) => s + extent.get(c)!, 0) + sp.node * Math.max(0, cs.length - 1)
    let at = start + (e - kids) / 2
    for (const c of cs) {
      place(c, at)
      at += extent.get(c)! + sp.node
    }
  }
  let at = 0
  for (const r of roots) {
    const e = measure(r)
    place(r, at)
    at += e + sp.node * 2
  }
  return pos
}

// ---------------------------------------------------------------------------
// grid and radial
// ---------------------------------------------------------------------------

/** Equal cells, row by row ('right') or column by column ('down'), each node centred in its cell. */
function grid(nodes: LayoutNode[], d: Direction, sp: Spacing): Map<string, Vec2> {
  const per = Math.ceil(Math.sqrt(nodes.length))
  const cw = Math.max(...nodes.map((n) => n.width)) + sp.node
  const ch = Math.max(...nodes.map((n) => n.height)) + sp.node
  return new Map(nodes.map((n, i) => {
    const [col, row] = d === 'right' ? [i % per, Math.floor(i / per)] : [Math.floor(i / per), i % per]
    return [n.key, { x: col * cw + (cw - n.width) / 2, y: row * ch + (ch - n.height) / 2 }]
  }))
}

/**
 * Rings around the best-connected node by BFS distance (unconnected nodes on an outer ring). Radii
 * keep the circles around each node (diameter = its diagonal) apart, so boxes cannot overlap.
 */
function radial(nodes: LayoutNode[], edges: LayoutEdge[], sp: Spacing): Map<string, Vec2> {
  const adj = new Map(nodes.map((n) => [n.key, [] as string[]]))
  for (const e of edges) {
    adj.get(e.from)!.push(e.to)
    adj.get(e.to)!.push(e.from)
  }
  const center = nodes.reduce((best, n) => (adj.get(n.key)!.length > adj.get(best.key)!.length ? n : best), nodes[0])
  const depth = new Map([[center.key, 0]])
  const order = [center.key]
  for (let i = 0; i < order.length; i++) {
    for (const t of adj.get(order[i])!) {
      if (depth.has(t)) continue
      depth.set(t, depth.get(order[i])! + 1)
      order.push(t)
    }
  }
  const outer = Math.max(...depth.values()) + 1
  for (const n of nodes) if (!depth.has(n.key)) { depth.set(n.key, outer); order.push(n.key) }

  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const diag = (k: string) => Math.hypot(byKey.get(k)!.width, byKey.get(k)!.height)
  const rings: string[][] = []
  for (const k of order) (rings[depth.get(k)!] ??= []).push(k)

  const pos = new Map<string, Vec2>()
  let radius = 0
  let prevDiag = 0
  for (const ring of rings.filter((r) => r?.length)) {
    const big = Math.max(...ring.map(diag))
    if (pos.size) {
      const chord = ring.length > 1 ? (big + sp.node) / (2 * Math.sin(Math.PI / ring.length)) : 0
      radius = Math.max(radius + (prevDiag + big) / 2 + sp.rank, chord)
    }
    ring.forEach((k, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / ring.length
      const n = byKey.get(k)!
      pos.set(k, { x: radius * Math.cos(a) - n.width / 2, y: radius * Math.sin(a) - n.height / 2 })
    })
    prevDiag = big
  }
  return pos
}
