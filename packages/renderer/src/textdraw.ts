import type { TextLayout } from './text'
import { lineOffsetX } from './text'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Draw laid-out text with its top-left at (x,y) in the current ctx space. */
export function drawTextLayout(
  ctx: Ctx2D,
  layout: TextLayout,
  color: string,
  align: 'left' | 'center' | 'right' | undefined,
  x = 0,
  y = 0,
): void {
  ctx.font = layout.font
  ctx.fillStyle = color
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  for (let i = 0; i < layout.lines.length; i++) {
    if (!layout.lines[i]) continue
    ctx.fillText(layout.lines[i], x + lineOffsetX(layout, i, align), y + i * layout.lineHeight + layout.baseline)
  }
}
