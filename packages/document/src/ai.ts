import type { NotebookDocumentApi } from './api'
import { formatRelation, renderBlock } from './markdown'
import { analyzeNotebook } from './semantic'

/**
 * Compact semantic context for the AI gateway: notebook title/tags, then per page the
 * reconstructed headings/text/lists/equations and diagram relationships. No pixels.
 */
export function summarizeForAI(doc: NotebookDocumentApi, opts: { maxChars?: number } = {}): string {
  const meta = doc.meta()
  const analysis = analyzeNotebook(doc)
  const lines: string[] = []
  lines.push(`NOTEBOOK "${meta.title}"${meta.tags.length ? ` tags: ${meta.tags.join(', ')}` : ''} (${analysis.length} page${analysis.length === 1 ? '' : 's'})`)
  analysis.forEach((pa, i) => {
    const p = pa.page
    lines.push(`--- PAGE ${i + 1}${p.title ? ` "${p.title}"` : ''} [${p.kind}${p.width ? ` ${p.width}x${p.height}` : ''}]`)
    let images = 0, drawings = 0
    for (const b of pa.blocks) {
      if (b.kind === 'image') images++
      else if (b.kind === 'placeholder') drawings++
      else lines.push(renderBlock(b))
    }
    if (pa.relations.length) lines.push(`RELATIONS: ${pa.relations.map(formatRelation).join('; ')}`)
    const extras: string[] = []
    if (images) extras.push(`${images} image${images === 1 ? '' : 's'}`)
    if (drawings) extras.push(`${drawings} unlabeled drawing${drawings === 1 ? '' : 's'}`)
    if (extras.length) lines.push(`ALSO: ${extras.join(', ')}`)
  })
  const text = lines.join('\n')
  const max = opts.maxChars ?? 20000
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
