/**
 * What folio learned about one writer's handwriting: image prep tuned by calibration, and
 * corrections learned from text the user fixed after Clean Up.
 *
 * The corrector is deliberately conservative. It only changes a word into one the user
 * wrote or typed before, and only through a word fix or character mix-up it has seen
 * recognition make on this writer's handwriting. Without a full dictionary, any looser
 * rule would "fix" valid words that just aren't in the personal vocabulary yet.
 */

export interface RasterTuning {
  /** Forward lean to shear upright (radians). */
  slant: number
  /** Ink height in the OCR image (px). */
  targetHeight: number
  /** Multiplier for the ink line width. */
  lineWidthScale: number
}

export interface HandwritingProfile {
  /** Image prep found by calibration; undefined keeps the defaults. */
  raster?: RasterTuning
  /** Last calibration and its character error rates (0..1) with default and tuned prep. */
  calibration?: { at: number; before: number; after: number }
  /** Personal vocabulary: lowercase word -> times written or typed. */
  words: Record<string, number>
  /** Lowercase recognized word -> corrected word -> times. */
  fixes: Record<string, Record<string, number>>
  /** Character mix-ups, keyed `${recognized}\u0000${meant}` -> times. */
  confusions: Record<string, number>
}

const MAX_WORDS = 5000
const MAX_FIXES = 1000
const MAX_CONFUSIONS = 300
/** A recognized/corrected pair this different is a rewrite, not a correction. */
const MAX_CORRECTION_CER = 0.5
/** Word pairs this different are not the same word misread. */
const MAX_WORD_CER = 0.6
/** Highest total cost of learned mix-ups the corrector accepts for one word. */
const MAX_FIX_COST = 0.75
const SEP = '\u0000'

export function emptyProfile(): HandwritingProfile {
  return { words: {}, fixes: {}, confusions: {} }
}

/** Validate stored data (unknown shape) into a profile. */
export function sanitizeProfile(raw: unknown): HandwritingProfile {
  const out = emptyProfile()
  if (!isRecord(raw)) return out
  const r = raw.raster
  if (isRecord(r) && isNum(r.slant) && isNum(r.targetHeight) && isNum(r.lineWidthScale)) {
    out.raster = {
      slant: clamp(r.slant, -0.8, 0.8),
      targetHeight: clamp(r.targetHeight, 40, 200),
      lineWidthScale: clamp(r.lineWidthScale, 0.3, 3),
    }
  }
  const c = raw.calibration
  if (isRecord(c) && isNum(c.at) && isNum(c.before) && isNum(c.after)) out.calibration = { at: c.at, before: c.before, after: c.after }
  out.words = counts(raw.words)
  out.confusions = counts(raw.confusions)
  if (isRecord(raw.fixes)) for (const [k, v] of Object.entries(raw.fixes)) out.fixes[k] = counts(v)
  return out
}

/** Add the words of typed or corrected text to the vocabulary. Mutates `p`. */
export function learnWords(p: HandwritingProfile, text: string): void {
  for (const t of tokens(text)) {
    const w = t.core.toLowerCase()
    if (w.length >= 2 && /\p{L}/u.test(w)) p.words[w] = (p.words[w] ?? 0) + 1
  }
  prune(p.words, MAX_WORDS)
}

/** Learn character mix-ups between what recognition read and what was meant. Mutates `p`. */
export function learnConfusions(p: HandwritingProfile, recognized: string, meant: string): void {
  for (const [a, b] of pairWords(recognized, meant)) {
    for (const [from, to] of charConfusions(a.toLowerCase(), b.toLowerCase())) {
      const k = from + SEP + to
      p.confusions[k] = (p.confusions[k] ?? 0) + 1
    }
  }
  prune(p.confusions, MAX_CONFUSIONS)
}

/**
 * Learn from text the user corrected: vocabulary, word fixes and character mix-ups.
 * Returns false (and learns nothing) when the edit is a rewrite rather than a correction.
 */
export function learnCorrection(p: HandwritingProfile, recognized: string, corrected: string): boolean {
  if (!corrected.trim() || recognized === corrected) return false
  if (cer(recognized, corrected) > MAX_CORRECTION_CER) return false
  learnWords(p, corrected)
  for (const [a, b] of pairWords(recognized, corrected)) {
    const from = a.toLowerCase()
    const fixes = (p.fixes[from] ??= {})
    fixes[b] = (fixes[b] ?? 0) + 1
  }
  learnConfusions(p, recognized, corrected)
  const keys = Object.keys(p.fixes)
  if (keys.length > MAX_FIXES) {
    const total = (k: string) => Object.values(p.fixes[k]).reduce((n, x) => n + x, 0)
    for (const k of keys.sort((x, y) => total(x) - total(y)).slice(0, keys.length - MAX_FIXES)) delete p.fixes[k]
  }
  return true
}

interface Confusion {
  from: string
  to: string
  cost: number
}

/** Build a text corrector from a profile (index once, apply to many lines). */
export function createCorrector(p: HandwritingProfile): (text: string) => string {
  const vocab = new Map(Object.entries(p.words))
  const confusions: Confusion[] = Object.entries(p.confusions).map(([k, n]) => {
    const [from, to] = k.split(SEP)
    return { from, to, cost: 1 / (1 + n) }
  })
  const byLength = new Map<number, string[]>()
  for (const w of vocab.keys()) {
    const list = byLength.get(w.length)
    if (list) list.push(w)
    else byLength.set(w.length, [w])
  }

  const fixFor = (lower: string): string | undefined => {
    const options = p.fixes[lower]
    if (!options) return undefined
    let best: string | undefined
    let n = 0
    for (const [to, k] of Object.entries(options)) if (k > n) [best, n] = [to, k]
    // one sighting is enough for a word the user never wrote; known words need two
    return best && (n >= 2 || !vocab.has(lower)) ? best : undefined
  }

  const correctWord = (core: string): string => {
    const lower = core.toLowerCase()
    const fix = fixFor(lower)
    if (fix) return matchCase(core, fix)
    if (vocab.has(lower) || lower.length < 3) return core
    const usable = confusions.filter((c) => lower.includes(c.from))
    if (!usable.length) return core
    let best: string | undefined
    let bestCost = MAX_FIX_COST
    let bestCount = 0
    for (let len = lower.length - 2; len <= lower.length + 2; len++) {
      for (const w of byLength.get(len) ?? []) {
        const cost = mixupCost(lower, w, usable, bestCost)
        const count = vocab.get(w)!
        if (cost < bestCost || (cost === bestCost && best !== undefined && count > bestCount)) [best, bestCost, bestCount] = [w, cost, count]
      }
    }
    return best ? matchCase(core, best) : core
  }

  return (text) => tokens(text).map((t) => t.lead + (t.core ? correctWord(t.core) : '') + t.trail).join(' ')
}

/** Character error rate: edit distance relative to the length of `truth`. */
export function cer(read: string, truth: string): number {
  const a = normalize(read)
  const b = normalize(truth)
  if (!b.length) return a.length ? 1 : 0
  return Math.min(1, editDistance(a, b) / b.length)
}

// ---------------------------------------------------------------------------

interface Token {
  lead: string
  core: string
  trail: string
}

function tokens(text: string): Token[] {
  return text.split(/\s+/).filter(Boolean).map((t) => {
    const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(t)!
    return { lead: m[1], core: m[2], trail: m[3] }
  })
}

/** Differing word pairs (recognized core, meant core) of two texts, aligned by edit distance. */
function pairWords(recognized: string, meant: string): [string, string][] {
  const a = tokens(recognized).map((t) => t.core).filter(Boolean)
  const b = tokens(meant).map((t) => t.core).filter(Boolean)
  const sub = (i: number, j: number) => (a[i] === b[j] ? 0 : cer(a[i], b[j]))
  const d = table(a.length, b.length)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + sub(i - 1, j - 1))
  }
  const out: [string, string][] = []
  let i = a.length
  let j = b.length
  while (i > 0 && j > 0) {
    if (d[i][j] === d[i - 1][j - 1] + sub(i - 1, j - 1)) {
      if (a[i - 1] !== b[j - 1] && cer(a[i - 1], b[j - 1]) <= MAX_WORD_CER) out.push([a[i - 1], b[j - 1]])
      i--
      j--
    } else if (d[i][j] === d[i - 1][j] + 1) i--
    else j--
  }
  return out.reverse()
}

/** Runs of 1-2 differing characters between two words, from an edit-distance alignment. */
function charConfusions(a: string, b: string): [string, string][] {
  const d = table(a.length, b.length)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  const out: [string, string][] = []
  let from = ''
  let to = ''
  const flush = () => {
    if (from && to && from.length <= 2 && to.length <= 2) out.push([from, to])
    from = to = ''
  }
  let i = a.length
  let j = b.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      flush()
      i--
      j--
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      from = a[--i] + from
      to = b[--j] + to
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      from = a[--i] + from
    } else {
      to = b[--j] + to
    }
  }
  flush()
  return out
}

/** Cost of reading `w` as `read` using only learned mix-ups; Infinity past `limit`. */
function mixupCost(read: string, w: string, confusions: Confusion[], limit: number): number {
  const d = table(read.length, w.length, Infinity)
  d[0][0] = 0
  let prevMin = 0
  for (let i = 0; i <= read.length; i++) {
    let rowMin = i === 0 ? 0 : Infinity
    for (let j = 0; j <= w.length; j++) {
      if (i === 0 && j === 0) continue
      let v = Infinity
      if (i > 0 && j > 0 && read[i - 1] === w[j - 1]) v = d[i - 1][j - 1]
      for (const c of confusions) {
        const fi = i - c.from.length
        const tj = j - c.to.length
        if (fi < 0 || tj < 0 || d[fi][tj] === Infinity) continue
        if (read.startsWith(c.from, fi) && w.startsWith(c.to, tj)) v = Math.min(v, d[fi][tj] + c.cost)
      }
      d[i][j] = v
      if (v < rowMin) rowMin = v
    }
    // mix-ups span up to two characters, so give up only after two hopeless rows
    if (rowMin > limit && prevMin > limit) return Infinity
    prevMin = rowMin
  }
  return d[read.length][w.length]
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/** Edit-distance table with the first row and column filled. */
function table(n: number, m: number, fill = 0): number[][] {
  const d = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(fill))
  if (fill === 0) {
    for (let i = 0; i <= n; i++) d[i][0] = i
    for (let j = 0; j <= m; j++) d[0][j] = j
  }
  return d
}

const normalize = (s: string) => s.trim().replace(/\s+/g, ' ')

function matchCase(original: string, word: string): string {
  if (original.length > 1 && original === original.toUpperCase()) return word.toUpperCase()
  if (original[0] !== original[0].toLowerCase()) return word[0].toUpperCase() + word.slice(1)
  return word
}

function prune(m: Record<string, number>, max: number): void {
  const keys = Object.keys(m)
  if (keys.length <= max) return
  for (const k of keys.sort((a, b) => m[a] - m[b]).slice(0, keys.length - max)) delete m[k]
}

function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (isRecord(v)) for (const [k, n] of Object.entries(v)) if (isNum(n) && n > 0) out[k] = n
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
