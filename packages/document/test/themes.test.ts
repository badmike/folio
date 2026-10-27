import { describe, expect, it } from 'vitest'
import { PALETTE, adaptColor, contrastRatio } from '../src/colors'
import { THEME_PRESETS, handFor, honoursSloppiness, resolveTheme, sanitizeThemeOverrides, themeColor, themeLineColor, themeVariant } from '../src/themes'

describe('themes', () => {
  it('resolves presets with sanitised overrides; unknown ids fall back to Hand-drawn', () => {
    const t = resolveTheme('sketchnote', { strokeScale: 9, font: 'comic', uppercase: false, paperLight: 'red', roughness: null })
    expect(t).toMatchObject({ id: 'sketchnote', font: 'gochi', uppercase: false, strokeScale: 3, roughness: null, paperLight: '#fafafa' })
    expect(resolveTheme('nope').id).toBe('rough')
    expect(resolveTheme('sketchnote').key).not.toBe(t.key)
    expect(sanitizeThemeOverrides({ shadow: 'yes', paperDark: '#ABCDEF' })).toEqual({ paperDark: '#abcdef' })
  })

  it("combines the theme's overdraw with each shape's wiggle", () => {
    const hands = THEME_PRESETS.sketchnote.hands!
    expect(handFor(resolveTheme('sketchnote'), 0)).toEqual({ ...hands.overdraw.artist, ...hands.wiggle.refined })
    expect(handFor(resolveTheme('sketchnote', { hand: 'sloppy' }), 2)).toEqual({ ...hands.overdraw.sloppy, ...hands.wiggle.sloppy })
    expect(handFor(resolveTheme('rough'), 2)).toBeNull()
    expect(sanitizeThemeOverrides({ hand: 'messy' })).toEqual({})
    expect(honoursSloppiness(resolveTheme('rough'))).toBe(true)
    expect(honoursSloppiness(resolveTheme('clean'))).toBe(false)
  })

  it('keeps the classic colour adaptation for Hand-drawn and Clean', () => {
    for (const id of ['rough', 'clean'] as const) {
      expect(themeColor(resolveTheme(id), '#e03131', '#121212')).toBe(adaptColor('#e03131', '#121212'))
      expect(themeColor(resolveTheme(id), '#1971c2', '#ffffff')).toBe('#1971c2')
    }
  })

  it('remaps palette colours per variant; the page background picks light or dark', () => {
    const t = resolveTheme('blueprint')
    expect(themeVariant(t, '#1d4f8c')).toBe(t.dark)
    expect(themeColor(t, '#1e1e1e', '#1d4f8c')).toBe('#f4f8ff')
    expect(themeColor(t, '#1e1e1e', '#f3f7fc')).toBe('#1b3a6b')
    // custom colours fall back to adaptColor
    expect(themeColor(t, '#123456', '#1d4f8c')).toBe(adaptColor('#123456', '#1d4f8c'))
    expect(themeColor(t, 'transparent', '#1d4f8c')).toBe('transparent')
  })

  it('keeps every themed stroke colour (darkest shade) legible on its paper', () => {
    for (const id of ['sketchnote', 'blueprint', 'chalkboard', 'whiteboard'] as const) {
      const t = resolveTheme(id)
      for (const paper of [t.paperLight, t.paperDark]) {
        for (const hue of PALETTE) {
          if (['transparent', 'white', 'gray'].includes(hue.name)) continue
          expect(contrastRatio(themeColor(t, hue.shades[4], paper), paper), `${id} ${hue.name} on ${paper}`).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  it('tints pattern lines with the theme ink', () => {
    expect(themeLineColor(resolveTheme('rough'), '#ffffff')).toBe('#c9ced6')
    expect(contrastRatio(themeLineColor(resolveTheme('blueprint'), '#1d4f8c'), '#1d4f8c')).toBeGreaterThan(1.2)
  })
})
