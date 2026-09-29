import type { SearchDoc, SearchHit } from './contract'

/** Snippet highlight markers (plain text, not HTML — callers must escape before rendering as HTML). */
export const SNIPPET_OPEN = '«'
export const SNIPPET_CLOSE = '»'

/** Lower-case and strip diacritics ("Übung" -> "ubung"), mirroring FTS5 `unicode61 remove_diacritics 2`. */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

const WORD = /[\p{L}\p{N}]+/gu

/** Normalised search tokens of a query string. */
export function tokenize(s: string): string[] {
  return normalize(s).match(WORD) ?? []
}

/**
 * Build an FTS5 MATCH expression: every token quoted (so user input can never be
 * interpreted as FTS syntax), the last one as prefix query for search-as-you-type.
 */
export function toFtsQuery(query: string): string | null {
  const tokens = tokenize(query)
  if (tokens.length === 0) return null
  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? '*' : ''}`).join(' ')
}

const KIND_BOOST: Record<SearchDoc['kind'], number> = {
  title: 2, tag: 1.5, label: 1.2, text: 1, handwriting: 0.9,
}

/**
 * Pure-JS search over documents (IndexedDB/memory backends and the LIKE fallback).
 * All query tokens must match a word of the text (last token by prefix); results are
 * scored by match count, exactness and document kind. Snippets highlight matched words.
 */
export function searchDocs(docs: Iterable<SearchDoc>, query: string, limit = 50): SearchHit[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const hits: SearchHit[] = []
  for (const doc of docs) {
    const words: { start: number; end: number; norm: string }[] = []
    for (const m of doc.text.matchAll(WORD)) {
      words.push({ start: m.index!, end: m.index! + m[0].length, norm: normalize(m[0]) })
    }
    const matched = new Set<number>()
    let score = 0
    let ok = true
    for (let ti = 0; ti < tokens.length; ti++) {
      const tok = tokens[ti]
      const isLast = ti === tokens.length - 1
      let found = false
      words.forEach((w, wi) => {
        if (w.norm === tok || (isLast && w.norm.startsWith(tok))) {
          found = true
          matched.add(wi)
          score += w.norm === tok ? 1 : 0.6
        }
      })
      if (!found) { ok = false; break }
    }
    if (!ok) continue
    // Shorter texts with the same matches are more relevant (rough bm25 length normalisation).
    score = (score * KIND_BOOST[doc.kind]) / (1 + Math.log2(1 + words.length) / 4)
    hits.push({ ...doc, snippet: makeSnippet(doc.text, words, matched), rank: score })
  }
  hits.sort((a, b) => b.rank - a.rank)
  return hits.slice(0, limit)
}

function makeSnippet(
  text: string, words: { start: number; end: number }[], matched: Set<number>, context = 6,
): string {
  const first = Math.min(...matched)
  const from = Math.max(0, first - context)
  const to = Math.min(words.length - 1, first + context * 2)
  let out = from > 0 ? '…' : ''
  let pos = words[from].start
  for (let i = from; i <= to; i++) {
    const w = words[i]
    out += text.slice(pos, w.start)
    out += matched.has(i)
      ? SNIPPET_OPEN + text.slice(w.start, w.end) + SNIPPET_CLOSE
      : text.slice(w.start, w.end)
    pos = w.end
  }
  if (to < words.length - 1) out += '…'
  return out
}
