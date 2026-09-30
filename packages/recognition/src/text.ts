import type { SemanticTextType } from '@folio/document'

/** Stable, deterministic recognition id from a set of stroke ids (order independent). */
export function recognitionId(strokeIds: string[]): string {
  const key = [...strokeIds].sort().join('\u0001')
  // two independent 32-bit FNV-1a style hashes -> 53+ bits, hex encoded
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ key.length
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
    h2 = (h2 ^ (h2 >>> 13)) >>> 0
  }
  return `rec_${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

const DE_WORDS = new Set(
  ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'für', 'auf', 'von', 'zu', 'den', 'dem', 'des', 'im', 'ich', 'sie', 'wir', 'auch', 'wie', 'oder', 'aber', 'bei', 'nach', 'aus', 'wird', 'sind', 'werden', 'einen', 'einem', 'als', 'noch', 'nur', 'wenn', 'kann', 'haben', 'zum', 'zur', 'über', 'vor', 'mehr', 'dass', 'diese', 'dieser', 'heute', 'morgen', 'aufgabe', 'übung', 'vorlesung', 'beispiel', 'lösung', 'ergebnis', 'zusammenfassung', 'einleitung', 'wichtig', 'frage', 'antwort', 'kapitel', 'gleichung', 'zeit', 'woche', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag', 'einkaufen', 'termin'],
)
const EN_WORDS = new Set(
  ['the', 'and', 'is', 'are', 'not', 'a', 'an', 'with', 'for', 'on', 'of', 'to', 'in', 'it', 'this', 'that', 'we', 'you', 'they', 'be', 'or', 'but', 'by', 'from', 'as', 'at', 'have', 'has', 'will', 'can', 'what', 'how', 'why', 'when', 'todo', 'notes', 'meeting', 'example', 'solution', 'result', 'summary', 'introduction', 'important', 'question', 'answer', 'chapter', 'equation', 'time', 'week', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'shopping', 'lecture', 'exercise'],
)

/**
 * Simple language guess. `allowed` restricts the result (default en + de).
 * Umlauts / ß are a strong German signal; otherwise stop-word votes decide, ties -> 'en'.
 */
export function detectLanguage(text: string, allowed: string[] = ['en', 'de']): string {
  const has = (l: string) => allowed.length === 0 || allowed.includes(l)
  if (!has('de')) return has('en') ? 'en' : allowed[0]
  if (!has('en')) return 'de'
  if (/[äöüßÄÖÜ]/.test(text)) return 'de'
  const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? []
  let de = 0
  let en = 0
  for (const w of words) {
    if (DE_WORDS.has(w)) de++
    if (EN_WORDS.has(w)) en++
    if (/(ung|keit|heit|schaft|lich|isch)$/.test(w) && w.length > 5) de += 0.5
    if (/(tion|ing|ness|ment|ly)$/.test(w) && w.length > 4) en += 0.5
  }
  return de > en ? 'de' : 'en'
}

const BULLET_RE = /^\s*([-–—•·*▪◦●○>»]|\d{1,2}[.)]|[a-z][.)])\s+\S/

export function guessSemanticType(
  text: string,
  bounds: { height: number },
  medianLineHeight: number,
): SemanticTextType | undefined {
  if (BULLET_RE.test(text) && !/^\d+[.,]\d/.test(text)) return 'list-item'
  if (medianLineHeight > 0 && bounds.height >= 1.6 * medianLineHeight && text.length <= 80) return 'heading'
  return undefined
}

const VARIANTS: [RegExp, string][] = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″«»]/g, '"'],
  [/[‒–—―−]/g, '-'],
  [/…/g, '...'],
  // an accent used as apostrophe inside a word: don´t -> don't
  [/(?<=\p{L})[´`](?=\p{L})/gu, "'"],
]
/** Glyphs OCR emits for specks and pen texture; never meaningful at a word edge. */
const TOKEN_NOISE = /^[|¦~^_`´]+|[|¦~^_`´]+$/g
const LONE_MARKS = /^[.,·'"]+$/
const LONE_DASH = /^-+$/

/**
 * Remove the noise OCR produces on handwriting: collapses whitespace, normalises quote and
 * dash variants, strips stray symbols around words, lone dots and unpaired edge quotes,
 * and returns '' when no letter or digit is left. Punctuation attached to a word
 * ("done.", "why?") and a leading list bullet ("- milk") are kept.
 */
export function cleanRecognizedText(text: string): string {
  let s = text
  for (const [re, to] of VARIANTS) s = s.replace(re, to)
  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(TOKEN_NOISE, ''))
    .filter((t) => t && !LONE_MARKS.test(t))
  while (tokens.length && LONE_DASH.test(tokens[tokens.length - 1])) tokens.pop()
  s = tokens.join(' ')
  // a quote at either end with no partner anywhere in the text is noise
  for (const q of ["'", '"']) {
    if (s.startsWith(q) && s.indexOf(q, 1) === -1) s = s.slice(1)
    if (s.endsWith(q) && s.lastIndexOf(q, s.length - 2) === -1) s = s.slice(0, -1)
  }
  return /[\p{L}\p{N}]/u.test(s) ? s : ''
}
