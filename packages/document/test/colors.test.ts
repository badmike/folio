import { describe, expect, it } from 'vitest'
import { adaptColor, contrastRatio, parseHex, PALETTE } from '../src/colors'

describe('colors', () => {
  it('parses hex forms', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseHex('#1e1e1e80')?.a).toBeCloseTo(0.5, 1)
    expect(parseHex('nope')).toBeNull()
  })
  it('keeps colours on light canvases', () => {
    expect(adaptColor('#1e1e1e', '#ffffff')).toBe('#1e1e1e')
  })
  it('makes every palette colour legible on dark canvases', () => {
    for (const hue of PALETTE) for (const c of hue.shades) {
      if (c === 'transparent') { expect(adaptColor(c, '#121212')).toBe('transparent'); continue }
      const out = adaptColor(c, '#121212')
      if (hue.name === 'black' || hue.name.startsWith('gray')) continue
      expect(contrastRatio(out, '#121212')).toBeGreaterThanOrEqual(2.9)
    }
    expect(contrastRatio(adaptColor('#1e1e1e', '#121212'), '#121212')).toBeGreaterThan(10)
  })
})
