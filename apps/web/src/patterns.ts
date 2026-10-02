import type { BackgroundPattern } from '@folio/document'
import { patternCoverageLevels, patternDensity, patternKind } from '@folio/renderer'

/** Page patterns in picker order. */
export const PATTERN_OPTIONS: { v: BackgroundPattern; label: string }[] = [
  { v: 'blank', label: 'Blank' }, { v: 'ruled', label: 'Ruled' }, { v: 'grid', label: 'Grid' }, { v: 'dot', label: 'Dots' },
  { v: 'music', label: 'Music' }, { v: 'isometric', label: 'Isometric' }, { v: 'hex', label: 'Hexagon' },
  { v: 'cornell', label: 'Cornell' }, { v: 'handwriting', label: 'Handwriting' }, { v: 'engineering', label: 'Engineering' },
  { v: 'isodot', label: 'Iso dots' }, { v: 'tablature', label: 'Tablature' }, { v: 'polar', label: 'Polar' },
]

const masks = new Map<BackgroundPattern, string>()

/**
 * A small picture of a pattern as a CSS mask (white where the lines are), drawn with the same
 * coverage maths as the canvas. Paint it with `background: currentColor` so it follows the theme.
 */
export function patternMask(pattern: BackgroundPattern, width = 64, height = 40): string {
  const hit = masks.get(pattern)
  if (hit) return hit
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return 'none'
  const img = ctx.createImageData(canvas.width, canvas.height)
  const spacing = 32
  // lines about 7 px apart, whatever the pattern's own density
  const zoom = 7 / patternDensity(pattern, spacing)
  const kind = patternKind(pattern)
  const levels = [{ spacing, alpha: 1 }]
  // a small fake page so cornell shows its cue column and summary line, and polar centres in the preview
  const page = { x: 0, y: 0, width: 70 / zoom, height: 50 / zoom }
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const c = patternCoverageLevels(kind, (x + 0.5) / scale / zoom + 1, (y + 0.5) / scale / zoom + 1, levels, zoom, 0, page)
      const i = (y * canvas.width + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = Math.round(c * 255)
    }
  }
  ctx.putImageData(img, 0, 0)
  const url = `url(${canvas.toDataURL()})`
  masks.set(pattern, url)
  return url
}
