/**
 * A small Markdown parser for model output: headings, lists (nested), paragraphs, quotes, fenced code,
 * rules, and inline bold, italic, code and links. It builds a tree that templates render as text, so
 * nothing the model writes ever becomes HTML. Unclosed markers (mid-stream) stay plain text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'paragraph'; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'code'; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'rule' }

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/

const indentOf = (line: string) => (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length
const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line)

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'))
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      out.push({ t: 'code', v: body.join('\n') })
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      out.push({ t: 'heading', level: Math.min(3, h[1].length) as 1 | 2 | 3, c: parseInline(h[2]) })
      i++
      continue
    }
    if (RULE.test(line)) { out.push({ t: 'rule' }); i++; continue }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1])
      out.push({ t: 'quote', c: parseBlocks(body) })
      continue
    }
    if (ITEM.test(line)) {
      const end = listEnd(lines, i)
      out.push(parseList(lines.slice(i, end)))
      i = end
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++].trim())
    out.push({ t: 'paragraph', c: parseInline(para.join(' ')) })
  }
  return out
}

/** A list runs until a blank line followed by something that is neither an item nor indented. */
function listEnd(lines: string[], start: number): number {
  const base = indentOf(lines[start])
  let i = start + 1
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim()) {
      const next = lines[i + 1]
      if (next === undefined || !(ITEM.test(next) || indentOf(next) > base)) break
      i++
      continue
    }
    if (indentOf(l) <= base && !ITEM.test(l) && startsBlock(l)) break
    i++
  }
  return i
}

function parseList(lines: string[]): Block {
  const first = ITEM.exec(lines[0])!
  const base = indentOf(lines[0])
  const ordered = /\d/.test(first[2])
  const items: string[][] = []
  for (const l of lines) {
    const m = ITEM.exec(l)
    if (m && indentOf(l) <= base) items.push([m[3]])
    else items.at(-1)?.push(l.slice(Math.min(indentOf(l), base + 2)))
  }
  return {
    t: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1,
    items: items.map((body) => {
      const [head, ...rest] = body
      // continuation lines that are not blocks of their own belong to the item's first paragraph
      let k = 0
      const lead = [head]
      while (k < rest.length && rest[k].trim() && !startsBlock(rest[k])) lead.push(rest[k++].trim())
      return [{ t: 'paragraph', c: parseInline(lead.join(' ')) } satisfies Block, ...parseBlocks(dedent(rest.slice(k)))]
    }),
  }
}

function dedent(lines: string[]): string[] {
  const min = Math.min(...lines.filter((l) => l.trim()).map(indentOf))
  return Number.isFinite(min) ? lines.map((l) => l.slice(Math.min(min, indentOf(l)))) : lines
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i
const ESCAPABLE = /[\\`*_[\]()#+\-.!>~]/

export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } }
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\' && ESCAPABLE.test(s[i + 1] ?? '')) { buf += s[i + 1]; i += 2; continue }
    if (ch === '`') {
      const j = s.indexOf('`', i + 1)
      if (j > i + 1) { flush(); out.push({ t: 'code', v: s.slice(i + 1, j) }); i = j + 1; continue }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] === ch) {
      const j = s.indexOf(ch + ch, i + 2)
      if (j > i + 2) { flush(); out.push({ t: 'strong', c: parseInline(s.slice(i + 2, j)) }); i = j + 2; continue }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] && s[i + 1] !== ' ' && !(ch === '_' && /\w/.test(s[i - 1] ?? ''))) {
      const j = closeEm(s, ch, i + 1)
      if (j > 0) { flush(); out.push({ t: 'em', c: parseInline(s.slice(i + 1, j)) }); i = j + 1; continue }
    }
    if (ch === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(s.slice(i))
      if (m) {
        flush()
        if (SAFE_HREF.test(m[2])) out.push({ t: 'link', href: m[2], c: parseInline(m[1]) })
        else out.push(...parseInline(m[1]))
        i += m[0].length
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

/** Closing `*` or `_` for an emphasis opened before `from`: not doubled, not after a space, `_` not inside a word. */
function closeEm(s: string, ch: string, from: number): number {
  for (let j = from + 1; j < s.length; j++) {
    if (s[j] !== ch) continue
    if (s[j + 1] === ch) { j++; continue }
    if (s[j - 1] === ' ') continue
    if (ch === '_' && /\w/.test(s[j + 1] ?? '')) continue
    return j
  }
  return -1
}
