import type { NotebookDocumentApi } from './api'
import { analyzeNotebook, type PageAnalysis, type Relation, type SemanticBlock } from './semantic'

export interface MarkdownOptions {
  /** Prefix the output with `# <notebook title>`. Default false. */
  includeTitle?: boolean
  /** Heading text for the relationships section. Default 'Diagram'. */
  diagramTitle?: string
}

export function formatRelation(r: Relation): string {
  return `${r.from} ${r.connector} ${r.to}${r.label ? ` (${r.label})` : ''}`
}

export function renderBlock(b: SemanticBlock): string {
  switch (b.kind) {
    case 'heading': return `${'#'.repeat(b.level)} ${b.text}`
    case 'paragraph': return b.text
    case 'list': return b.items.join('\n')
    case 'equation': return `$$${b.text.trim()}$$`
    case 'image': return `![image](asset:${b.assetId})`
    case 'placeholder': return '[Diagram]'
  }
}

/**
 * Semantic Markdown reconstruction: reading order, headings, lists, equations, images and a
 * relationship list for connected diagram shapes. Not a concatenation of OCR output.
 */
export function exportMarkdown(doc: NotebookDocumentApi, opts: MarkdownOptions = {}): string {
  const analysis = analyzeNotebook(doc)
  const multi = analysis.length > 1
  const parts: string[] = []
  if (opts.includeTitle) parts.push(`# ${doc.meta().title}`)
  analysis.forEach((pa, i) => {
    if (multi) parts.push(`## ${pa.page.title.trim() || `Page ${i + 1}`}`)
    parts.push(...pageParts(pa, opts))
  })
  return parts.join('\n\n') + (parts.length ? '\n' : '')
}

function pageParts(pa: PageAnalysis, opts: MarkdownOptions): string[] {
  const parts = pa.blocks.map(renderBlock)
  if (pa.relations.length) {
    parts.push(`### ${opts.diagramTitle ?? 'Diagram'}`)
    parts.push(pa.relations.map((r) => `- ${formatRelation(r)}`).join('\n'))
  }
  return parts
}
