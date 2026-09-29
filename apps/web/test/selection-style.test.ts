import { describe, expect, it } from 'vitest'
import { selectionStylePatch } from '../src/notebook'

describe('selectionStylePatch', () => {
  it('maps pen / highlighter options', () => {
    expect(selectionStylePatch('pen', { color: '#f00', width: 5, pressureSensitive: false })).toEqual({ color: '#f00', width: 5 })
    expect(selectionStylePatch('highlighter', { opacity: 0.4 })).toEqual({ opacity: 0.4 })
  })
  it('maps shape / arrow stroke fields', () => {
    expect(selectionStylePatch('shape', { strokeColor: '#00f', strokeWidth: 3, opacity: 0.8, fillColor: '#fff', roughness: 2 })).toEqual({ color: '#00f', width: 3, opacity: 0.8 })
    expect(selectionStylePatch('arrow', { strokeWidth: 6 })).toEqual({ width: 6 })
  })
  it('maps text colour and ignores unrelated changes', () => {
    expect(selectionStylePatch('text', { color: '#0a0', fontSize: 30 })).toEqual({ color: '#0a0' })
    expect(selectionStylePatch('shape', { kind: 'ellipse' })).toBeNull()
    expect(selectionStylePatch('eraser', { size: 30 })).toBeNull()
    expect(selectionStylePatch('select', { mode: 'lasso' })).toBeNull()
  })
})
