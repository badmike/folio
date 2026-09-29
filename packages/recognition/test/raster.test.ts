import { describe, expect, it } from 'vitest'
import { encodePng, planRaster, rasterize, rasterizeToPng, zlibStored } from '../src/raster'
import { makeStroke, polyline } from './helpers'
import { inflateSync } from 'node:zlib'

const line = (x0: number, y0: number, x1: number, y1: number, id = 's') => makeStroke(polyline([{ x: x0, y: y0 }, { x: x1, y: y1 }], false, 2), { id })

describe('rasterize', () => {
  it('normalises ink height and adds padding', () => {
    const strokes = [line(0, 0, 0, 40, 'a'), line(0, 40, 200, 40, 'b')]
    const bmp = rasterize(strokes, { targetHeight: 80, padding: 20 })
    expect(bmp.height).toBe(80 + 40)
    expect(bmp.width).toBe(Math.ceil(200 * 2 + 40))
    expect(bmp.data.length).toBe(bmp.width * bmp.height)
    // corners are paper, some ink exists
    expect(bmp.data[0]).toBe(255)
    expect(bmp.data.some((v) => v < 50)).toBe(true)
  })

  it('does not blow up a lone flat stroke to the full target height', () => {
    const plan = planRaster([line(0, 0, 60, 0)])
    expect(plan.scale).toBeLessThan(6.01)
    const plan2 = planRaster([line(0, 0, 60, 2)])
    expect(plan2.height).toBeLessThanOrEqual(200)
  })

  it('caps the width by reducing the scale', () => {
    const plan = planRaster([line(0, 0, 100000, 40)], { maxWidth: 1000 })
    expect(plan.width).toBeLessThanOrEqual(1001)
  })

  it('thickens lines (ink is wider than 1px)', () => {
    const bmp = rasterize([line(0, 0, 100, 0)], { targetHeight: 80, lineWidth: 6 })
    let inkRows = 0
    const x = Math.floor(bmp.width / 2)
    for (let y = 0; y < bmp.height; y++) if (bmp.data[y * bmp.width + x] < 128) inkRows++
    expect(inkRows).toBeGreaterThanOrEqual(5)
  })

  it('applies object transforms', () => {
    const s = makeStroke(polyline([{ x: 0, y: 0 }, { x: 50, y: 0 }], false), { transform: { x: 500, y: 500 } })
    const plan = planRaster([s])
    expect(plan.polylines[0][0].x).toBe(plan.padding)
  })
})

describe('PNG encoding', () => {
  it('produces a valid grayscale PNG whose data round-trips', async () => {
    const bmp = rasterize([line(0, 0, 30, 30)], { targetHeight: 40, padding: 4 })
    const png = await encodePng(bmp)
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const dv = new DataView(png.buffer, png.byteOffset)
    expect(dv.getUint32(16)).toBe(bmp.width)
    expect(dv.getUint32(20)).toBe(bmp.height)
    // find IDAT and inflate
    let off = 8
    const idat: Uint8Array[] = []
    while (off < png.length) {
      const len = dv.getUint32(off)
      const type = String.fromCharCode(...png.slice(off + 4, off + 8))
      if (type === 'IDAT') idat.push(png.slice(off + 8, off + 8 + len))
      off += 12 + len
    }
    const raw = inflateSync(Buffer.concat(idat))
    expect(raw.length).toBe((bmp.width + 1) * bmp.height)
    expect(raw[1]).toBe(bmp.data[0])
  })

  it('stored-zlib fallback is valid zlib', () => {
    const data = new Uint8Array(70000).map((_, i) => i % 251)
    expect(new Uint8Array(inflateSync(zlibStored(data)))).toEqual(data)
  })

  it('rasterizeToPng reports dimensions', async () => {
    const r = await rasterizeToPng([line(0, 0, 100, 20)])
    expect(r.width).toBeGreaterThan(0)
    expect(r.png.length).toBeGreaterThan(50)
  })
})
