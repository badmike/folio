/** Markdown split into the blocks create_text turns into text objects. Inline markup is dropped. */
export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; text: string }
  | { kind: 'equation'; text: string }
  | { kind: 'code'; text: string }

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)[-*+•]\s+(.*)$/
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/

function inline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\s][^*_]*?)[*_](?=$|[^*\w])/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

export function parseMarkdown(md: string): MdBlock[] {
  const out: MdBlock[] = []
  let para: string[] = []
  let list: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'paragraph', text: para.join(' ') })
    if (list.length) out.push({ kind: 'list', text: list.join('\n') })
    para = []
    list = []
  }
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
      if (code.length) out.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    if (/^\s*\$\$/.test(line)) {
      flush()
      const body = [line.trim().replace(/^\$\$/, '')]
      while (!body[body.length - 1].trimEnd().endsWith('$$') && ++i < lines.length) body.push(lines[i])
      const text = body.join('\n').trim().replace(/\$\$$/, '').trim()
      if (text) out.push({ kind: 'equation', text })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const h = HEADING.exec(line)
    if (h) {
      flush()
      out.push({ kind: 'heading', level: h[1].length === 1 ? 1 : h[1].length === 2 ? 2 : 3, text: inline(h[2]) })
      continue
    }
    const b = BULLET.exec(line)
    const n = NUMBERED.exec(line)
    const item = b ? { indent: b[1], text: `- ${inline(b[2])}` } : n ? { indent: n[1], text: `${n[2]}. ${inline(n[3])}` } : null
    if (item) {
      if (para.length) { out.push({ kind: 'paragraph', text: para.join(' ') }); para = [] }
      list.push('  '.repeat(Math.min(3, Math.floor(item.indent.length / 2))) + item.text)
      continue
    }
    if (list.length) {
      // a lazy continuation line belongs to the last item
      list[list.length - 1] += ` ${inline(line)}`
      continue
    }
    para.push(inline(line))
  }
  flush()
  return out
}
