import { nanoid } from 'nanoid'
import {
  PAGE_FORMATS,
  type Page,
  type PageBackground,
  type PageFormat,
  type PageKind,
  type ShapeStyle,
  type ToolSettings,
  type Transform,
} from './types'

/** Globally unique, URL-safe id. */
export function createId(): string {
  return nanoid(12)
}

export function identityTransform(): Transform {
  return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
}

export function defaultBackground(pattern: PageBackground['pattern'] = 'blank'): PageBackground {
  return { pattern, spacing: 32, opacity: 0.5, color: '#ffffff', lineColor: '#d0d4da' }
}

export function defaultShapeStyle(seed = 1): ShapeStyle {
  return { strokeColor: '#1e1e1e', strokeWidth: 2, opacity: 1, roughness: 1, seed }
}

/** Excalidraw-like defaults. */
export function defaultToolSettings(): ToolSettings {
  return {
    pen: { tool: 'pen', color: '#1e1e1e', width: 2.5, opacity: 1, pressureSensitive: true },
    highlighter: { tool: 'highlighter', color: '#ffd43b', width: 18, opacity: 0.35, pressureSensitive: false },
    shape: defaultShapeStyle(1),
    eraserSize: 24,
  }
}

export interface CreatePageOptions {
  kind?: PageKind
  format?: PageFormat
  id?: string
  title?: string
  order?: number
  width?: number
  height?: number
  background?: PageBackground
  now?: number
}

/** Build a Page. Fixed pages get width/height from PAGE_FORMATS (default A4) unless Custom. */
export function createPage(opts: CreatePageOptions = {}): Page {
  const kind = opts.kind ?? 'infinite'
  const now = opts.now ?? Date.now()
  const page: Page = {
    id: opts.id ?? createId(),
    title: opts.title ?? '',
    kind,
    background: opts.background ?? defaultBackground(),
    order: opts.order ?? 0,
    createdAt: now,
    updatedAt: now,
  }
  if (kind === 'fixed') {
    const format = opts.format ?? 'A4'
    page.format = format
    if (format === 'Custom') {
      page.width = opts.width ?? PAGE_FORMATS.A4.width
      page.height = opts.height ?? PAGE_FORMATS.A4.height
    } else {
      page.width = PAGE_FORMATS[format].width
      page.height = PAGE_FORMATS[format].height
    }
  } else if (opts.format) {
    page.format = opts.format
  }
  return page
}
