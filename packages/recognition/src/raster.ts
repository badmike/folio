import type { InkStroke, Vec2 } from '@folio/document'
import { boundsOf, distToSegment, median, percentile, strokeWorldPoints } from './geometry'

/**
 * Deterministic software rasterizer: strokes -> grayscale bitmap (black ink on white),
 * height-normalised, padded, with thickened lines. It has no DOM/canvas dependency, so
 * it behaves identically in the recognition worker, the main thread, node and tests.
 */

export interface RasterOptions {
  /**
   * Target height (px) of the ink bounding box, ascender to descender. Default 100, which
   * gives Tesseract's LSTM roughly the 30 to 40 px x-height it reads best.
   */
  targetHeight?: number
  /** White padding around the ink in px. Default 32. */
  padding?: number
  /** Upper bound for the bitmap width (px); the scale is reduced to fit. Default 3200. */
  maxWidth?: number
  /** Ink line width in px; default derived from the target height (~7% of it, 3..9 px). */
  lineWidth?: number
  /** Rotate a slanted line so its baseline is horizontal. Default true. */
  deskew?: boolean
}

export interface Bitmap {
  width: number
  height: number
  /** 8-bit grayscale, row-major, 255 = white paper, 0 = ink. */
  data: Uint8Array
  /** world -> pixel scale factor used. */
  scale: number
}

export interface RasterPlan {
  scale: number
  width: number
  height: number
  padding: number
  lineWidth: number
  /** Baseline angle (radians, y down) that was rotated away; 0 when not deskewed. */
  skew: number
  /** Polylines in pixel space. */
  polylines: Vec2[][]
}

const MIN_SKEW = (1.5 * Math.PI) / 180
const MAX_SKEW = (25 * Math.PI) / 180
const ENVELOPE_BINS = 24

/**
 * Baseline angle (radians, y down, positive = falling to the right) of a line of ink.
 * Takes the lowest point in each of a few vertical slices (the lower envelope) and fits
 * a Theil-Sen line through them: the median of pairwise slopes ignores descenders.
 */
export function estimateSkew(polys: Vec2[][]): number {
  const pts = lowerEnvelope(polys.flat())
  const slopes: number[] = []
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x
      if (dx !== 0) slopes.push((pts[j].y - pts[i].y) / dx)
    }
  }
  return slopes.length < 3 ? 0 : Math.atan(median(slopes))
}

/** Lowest point in each of a few vertical slices of the ink, left to right. */
export function lowerEnvelope(pts: Vec2[]): Vec2[] {
  const bb = boundsOf(pts)
  if (bb.width <= 0) return []
  const low: Vec2[] = []
  for (const p of pts) {
    const i = Math.min(ENVELOPE_BINS - 1, Math.floor(((p.x - bb.x) / bb.width) * ENVELOPE_BINS))
    if (!low[i] || p.y > low[i].y) low[i] = p
  }
  return low.filter(Boolean)
}

/** Rotate by -angle about the centre of the ink so a baseline at `angle` becomes horizontal. */
function unrotate(polys: Vec2[][], angle: number): Vec2[][] {
  const bb = boundsOf(polys.flat())
  const cx = bb.x + bb.width / 2
  const cy = bb.y + bb.height / 2
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return polys.map((p) =>
    p.map((q) => {
      const dx = q.x - cx
      const dy = q.y - cy
      return { x: cx + dx * c + dy * s, y: cy - dx * s + dy * c }
    }),
  )
}

export function planRaster(strokes: InkStroke[], opts: RasterOptions = {}): RasterPlan {
  const targetHeight = opts.targetHeight ?? 100
  const padding = opts.padding ?? 32
  const maxWidth = opts.maxWidth ?? 3200
  let worldPolys = strokes.map(strokeWorldPoints).filter((p) => p.length > 0)
  let skew = 0
  if (opts.deskew ?? true) {
    const raw = boundsOf(worldPolys.flat())
    // Short words have too little baseline to measure; leave them alone.
    if (worldPolys.length >= 3 || raw.width >= 2 * raw.height) {
      const angle = estimateSkew(worldPolys)
      if (Math.abs(angle) >= MIN_SKEW && Math.abs(angle) <= MAX_SKEW) {
        worldPolys = unrotate(worldPolys, angle)
        skew = angle
      }
    }
  }
  const all = worldPolys.flat()
  const bb = boundsOf(all)
  // Reference height: the ink box, but never smaller than a typical stroke height
  // (a lone hyphen or dot must not be blown up to the full target height).
  const heights = worldPolys.map((p) => boundsOf(p).height)
  const ref = Math.max(bb.height, 0.9 * percentile(heights, 0.6), 1)
  let scale = Math.min(6, targetHeight / ref)
  if (bb.width * scale + 2 * padding > maxWidth) scale = (maxWidth - 2 * padding) / Math.max(bb.width, 1)
  const lineWidth = opts.lineWidth ?? Math.min(9, Math.max(3, Math.round(0.07 * Math.min(targetHeight, bb.height * scale || targetHeight))))
  const width = Math.max(1, Math.ceil(bb.width * scale + 2 * padding))
  const height = Math.max(1, Math.ceil(bb.height * scale + 2 * padding))
  const polylines = worldPolys.map((p) => p.map((q) => ({ x: (q.x - bb.x) * scale + padding, y: (q.y - bb.y) * scale + padding })))
  return { scale, width, height, padding, lineWidth, skew, polylines }
}

export function rasterize(strokes: InkStroke[], opts: RasterOptions = {}): Bitmap {
  const plan = planRaster(strokes, opts)
  const { width, height, lineWidth } = plan
  const data = new Uint8Array(width * height).fill(255)
  const r = lineWidth / 2
  const paint = (a: Vec2, b: Vec2) => {
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r - 1))
    const x1 = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + r + 1))
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r - 1))
    const y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + r + 1))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = distToSegment({ x: x + 0.5, y: y + 0.5 }, a, b)
        const cov = r + 0.5 - d
        if (cov <= 0) continue
        const v = Math.round(255 * (1 - Math.min(1, cov)))
        const i = y * width + x
        if (v < data[i]) data[i] = v
      }
    }
  }
  for (const poly of plan.polylines) {
    if (poly.length === 1) paint(poly[0], poly[0])
    for (let i = 1; i < poly.length; i++) paint(poly[i - 1], poly[i])
  }
  return { width, height, data, scale: plan.scale }
}

// ---------------------------------------------------------------------------
// PNG encoding (grayscale, 8 bit)
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null
function crc32(buf: Uint8Array, seed = 0xffffffff): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = seed
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c
}

function adler32(buf: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** zlib stream using stored (uncompressed) deflate blocks: always available. */
export function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535))
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  out[0] = 0x78
  out[1] = 0x01
  let o = 2
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535
    const len = Math.min(65535, raw.length - start)
    out[o++] = b === blocks - 1 ? 1 : 0
    out[o++] = len & 0xff
    out[o++] = len >>> 8
    out[o++] = ~len & 0xff
    out[o++] = (~len >>> 8) & 0xff
    out.set(raw.subarray(start, start + len), o)
    o += len
  }
  const ad = adler32(raw)
  out[o++] = ad >>> 24
  out[o++] = (ad >>> 16) & 0xff
  out[o++] = (ad >>> 8) & 0xff
  out[o++] = ad & 0xff
  return out
}

async function zlibDeflate(raw: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => { writable: WritableStream; readable: ReadableStream } }).CompressionStream
  if (!CS) return zlibStored(raw)
  try {
    const cs = new CS('deflate')
    const writer = cs.writable.getWriter()
    void writer.write(raw as BufferSource as never)
    void writer.close()
    const chunks: Uint8Array[] = []
    const reader = cs.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value as Uint8Array)
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let o = 0
    for (const c of chunks) {
      out.set(c, o)
      o += c.length
    }
    return out
  } catch {
    return zlibStored(raw)
  }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crc = (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0
  dv.setUint32(8 + data.length, crc)
  return out
}

export async function encodePng(bmp: Pick<Bitmap, 'width' | 'height' | 'data'>): Promise<Uint8Array> {
  const { width, height, data } = bmp
  const raw = new Uint8Array((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0 // filter: none
    raw.set(data.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await zlibDeflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(s)
}

export async function rasterizeToPng(strokes: InkStroke[], opts: RasterOptions = {}): Promise<{ png: Uint8Array; width: number; height: number }> {
  const bmp = rasterize(strokes, opts)
  return { png: await encodePng(bmp), width: bmp.width, height: bmp.height }
}
