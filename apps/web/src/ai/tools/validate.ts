/**
 * Tiny runtime validators for tool inputs. Tool input comes from the model, so every field is
 * checked and every error names the path and what was expected, which lets the model fix its call.
 */

/** A failure the model can act on. Returned as an `isError` tool result, never thrown past the runner. */
export class ToolError extends Error {
  override name = 'ToolError'
}

export type Parser<T> = (value: unknown, path: string) => T
type OptionalParser<T> = Parser<T | undefined> & { optional: true }
type AnyParser = Parser<unknown> | OptionalParser<unknown>
export type Infer<P> = P extends Parser<infer T> ? T : never

type Simplify<T> = { [K in keyof T]: T[K] } & {}
type Shape = Record<string, AnyParser>
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends { optional: true } ? K : never }[keyof S]
export type ObjectOf<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined> }
>

const fail = (path: string, msg: string): never => {
  throw new ToolError(`${path || 'input'}: ${msg}`)
}
const describe = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

export const str = (o: { min?: number; max?: number; pattern?: RegExp; hint?: string } = {}): Parser<string> => (v, p) => {
  if (typeof v !== 'string') return fail(p, `expected a string, got ${describe(v)}`)
  const s = v.trim()
  if (s.length < (o.min ?? 0)) return fail(p, o.min === 1 ? 'must not be empty' : `must have at least ${o.min} characters`)
  if (o.max !== undefined && s.length > o.max) return fail(p, `must have at most ${o.max} characters`)
  if (o.pattern && !o.pattern.test(s)) return fail(p, `expected ${o.hint ?? o.pattern.source}, got ${JSON.stringify(s)}`)
  return s
}

export const num = (o: { min?: number; max?: number } = {}): Parser<number> => (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail(p, `expected a finite number, got ${describe(v)}`)
  if (o.min !== undefined && v < o.min) return fail(p, `must be at least ${o.min}`)
  if (o.max !== undefined && v > o.max) return fail(p, `must be at most ${o.max}`)
  return v
}

export const int = (o: { min?: number; max?: number } = {}): Parser<number> => (v, p) => {
  const n = num(o)(v, p)
  return Number.isInteger(n) ? n : fail(p, 'expected an integer')
}

export const bool: Parser<boolean> = (v, p) => (typeof v === 'boolean' ? v : fail(p, `expected true or false, got ${describe(v)}`))

export const oneOf = <const T extends readonly string[]>(values: T): Parser<T[number]> => (v, p) =>
  typeof v === 'string' && values.includes(v) ? v : fail(p, `expected one of ${values.join(', ')}, got ${JSON.stringify(v)}`)

export const arr = <T>(item: Parser<T>, o: { min?: number; max?: number } = {}): Parser<T[]> => (v, p) => {
  if (!Array.isArray(v)) return fail(p, `expected an array, got ${describe(v)}`)
  if (v.length < (o.min ?? 0)) return fail(p, `needs at least ${o.min} item${o.min === 1 ? '' : 's'}`)
  if (o.max !== undefined && v.length > o.max) return fail(p, `allows at most ${o.max} items`)
  return v.map((x, i) => item(x, `${p}[${i}]`))
}

export const opt = <T>(p: Parser<T>): OptionalParser<T> =>
  Object.assign((v: unknown, path: string) => (v === undefined || v === null ? undefined : p(v, path)), { optional: true as const })

export const obj = <S extends Shape>(shape: S): Parser<ObjectOf<S>> => (v, p) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, `expected an object, got ${describe(v)}`)
  const rec = v as Record<string, unknown>
  const unknown = Object.keys(rec).filter((k) => !(k in shape))
  if (unknown.length) fail(p, `unknown field ${unknown.join(', ')}; allowed: ${Object.keys(shape).join(', ')}`)
  const out: Record<string, unknown> = {}
  for (const [k, parse] of Object.entries(shape)) {
    const val = parse(rec[k], p ? `${p}.${k}` : k)
    if (val !== undefined) out[k] = val
  }
  return out as ObjectOf<S>
}

/** Parse the whole input of a tool. `undefined` input counts as `{}`. */
export const parseInput = <T>(parser: Parser<T>, input: unknown): T => parser(input ?? {}, '')

// ---------------------------------------------------------------------------
// Shared field parsers
// ---------------------------------------------------------------------------

export const id = str({ min: 1, max: 64 })
export const hex = str({ pattern: /^#[0-9a-f]{6}$/i, hint: 'a colour like #1e1e1e' })
export const fill = str({ pattern: /^(#[0-9a-f]{6}|transparent)$/i, hint: 'a colour like #ffec99 or "transparent"' })
export const coord = num({ min: -1e6, max: 1e6 })
export const size = num({ min: 1, max: 20000 })
export const point = obj({ x: coord, y: coord })
export const rect = obj({ x: coord, y: coord, width: size, height: size })

/** Where a page-scoped tool acts: defaults to what the user is looking at. */
export const where = { notebookId: opt(id), pageId: opt(id) }
