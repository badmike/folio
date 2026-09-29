import type { FontFamily, TextObject } from '@folio/document'

export const FONT_FAMILIES: Record<FontFamily, string> = {
  hand: "'Caveat', 'Comic Sans MS', cursive",
  sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: 'monospace',
}

export function fontString(size: number, family: FontFamily): string {
  return `${size}px ${FONT_FAMILIES[family] ?? FONT_FAMILIES.sans}`
}

export type TextLike = Pick<TextObject, 'text' | 'fontSize' | 'fontFamily' | 'width' | 'align'>

export interface TextLayout {
  lines: string[]
  lineWidths: number[]
  lineHeight: number
  /** Box size in local units (width = wrap width when set, else widest line). */
  width: number
  height: number
  font: string
}

export type WidthMeasurer = (font: string, text: string) => number

let measureCtx: { font: string; measureText(t: string): { width: number } } | null | undefined
let customMeasurer: WidthMeasurer | null = null

/** Override text measuring (tests, or environments without canvas). */
export function setTextMeasurer(fn: WidthMeasurer | null): void {
  customMeasurer = fn
  layoutCache.clear()
}

function getMeasureCtx(): typeof measureCtx {
  if (measureCtx !== undefined) return measureCtx
  measureCtx = null
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      measureCtx = new OffscreenCanvas(1, 1).getContext('2d') as typeof measureCtx
    }
  } catch { /* fall through */ }
  if (!measureCtx) {
    try {
      if (typeof document !== 'undefined') {
        measureCtx = document.createElement('canvas').getContext('2d') as typeof measureCtx
      }
    } catch { /* ignore */ }
  }
  return measureCtx ?? null
}

/** Reset the cached measuring context (call after web fonts finished loading). */
export function resetTextMetrics(): void {
  layoutCache.clear()
}

function estimateWidth(font: string, text: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  const size = m ? parseFloat(m[1]) : 16
  const factor = font.includes('monospace') ? 0.6 : font.includes('Caveat') ? 0.42 : 0.55
  return text.length * size * factor
}

const defaultMeasurer: WidthMeasurer = (font, text) => {
  const ctx = getMeasureCtx()
  if (!ctx) return estimateWidth(font, text)
  if (ctx.font !== font) ctx.font = font
  return ctx.measureText(text).width
}

const layoutCache = new Map<string, TextLayout>()

export function layoutText(t: TextLike): TextLayout {
  const key = `${t.fontFamily}|${t.fontSize}|${t.width ?? ''}|${t.text}`
  const hit = layoutCache.get(key)
  if (hit) return hit
  const font = fontString(t.fontSize, t.fontFamily)
  const measure = customMeasurer ?? defaultMeasurer
  const wrap = t.width && t.width > 0 ? t.width : undefined
  const lines: string[] = []
  for (const para of t.text.split('\n')) {
    if (wrap === undefined || measure(font, para) <= wrap) {
      lines.push(para)
      continue
    }
    let cur = ''
    for (const word of para.split(/(?<=\s)/)) {
      const next = cur + word
      if (cur && measure(font, next.trimEnd()) > wrap) {
        lines.push(cur.trimEnd())
        cur = word
      } else cur = next
      // break over-long words by character
      while (measure(font, cur.trimEnd()) > wrap && cur.length > 1) {
        let n = cur.length - 1
        while (n > 1 && measure(font, cur.slice(0, n)) > wrap) n--
        lines.push(cur.slice(0, n))
        cur = cur.slice(n)
      }
    }
    lines.push(cur.trimEnd())
  }
  const lineWidths = lines.map((l) => measure(font, l))
  const lineHeight = t.fontSize * (t.fontFamily === 'hand' ? 1.2 : 1.3)
  const layout: TextLayout = {
    lines,
    lineWidths,
    lineHeight,
    width: wrap ?? Math.max(0, ...lineWidths),
    height: lines.length * lineHeight,
    font,
  }
  if (layoutCache.size > 800) layoutCache.clear()
  layoutCache.set(key, layout)
  return layout
}

/** Text box size in local units. Used by editor hit-testing and bounds. */
export function measureText(obj: TextLike): { width: number; height: number; lines: number } {
  const l = layoutText(obj)
  return { width: l.width, height: l.height, lines: l.lines.length }
}

/** x offset of a line within the layout box for the given alignment. */
export function lineOffsetX(layout: TextLayout, lineIndex: number, align: TextLike['align']): number {
  const free = layout.width - layout.lineWidths[lineIndex]
  return align === 'center' ? free / 2 : align === 'right' ? free : 0
}

/** Label font for shapes/arrows. */
export function labelLayout(label: string, boxWidth: number, clean: boolean, fit = false): TextLayout {
  const layout = layoutText({
    text: label,
    fontSize: 18,
    fontFamily: clean ? 'sans' : 'hand',
    width: Math.max(20, boxWidth - 16),
    align: 'center',
  })
  // `fit` shrinks the box to the widest line (arrow labels paint a background behind
  // the text, which must not extend over the shaft beyond the text itself).
  if (!fit) return layout
  return { ...layout, width: Math.max(1, ...layout.lineWidths) }
}
