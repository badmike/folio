/** Minimal CSS colour parsing (hex / rgb[a] / hsl[a] / a few names) → normalised RGBA. */

export type RGBA = [number, number, number, number]

const NAMED: Record<string, RGBA> = {
  black: [0, 0, 0, 1],
  white: [1, 1, 1, 1],
  transparent: [0, 0, 0, 0],
  red: [1, 0, 0, 1],
  green: [0, 0.5, 0, 1],
  blue: [0, 0, 1, 1],
  yellow: [1, 1, 0, 1],
  orange: [1, 0.647, 0, 1],
  purple: [0.5, 0, 0.5, 1],
  gray: [0.5, 0.5, 0.5, 1],
  grey: [0.5, 0.5, 0.5, 1],
}

const cache = new Map<string, RGBA>()

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

function num(s: string, pctScale = 1): number {
  const t = s.trim()
  return t.endsWith('%') ? (parseFloat(t) / 100) * pctScale : parseFloat(t)
}

export function parseColor(css: string | undefined): RGBA {
  if (!css) return [0, 0, 0, 1]
  const hit = cache.get(css)
  if (hit) return hit
  let out: RGBA = [0, 0, 0, 1]
  const s = css.trim().toLowerCase()
  if (s.startsWith('#')) {
    let h = s.slice(1)
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    if (h.length === 6 || h.length === 8) {
      const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
      out = [v(0), v(2), v(4), h.length === 8 ? v(6) : 1]
    }
  } else if (s.startsWith('rgb') || s.startsWith('hsl')) {
    const m = s.match(/\(([^)]*)\)/)
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean)
      const alpha = parts.length > 3 ? Math.max(0, Math.min(1, num(parts[3]))) : 1
      if (s.startsWith('rgb')) {
        out = [num(parts[0], 255) / 255, num(parts[1], 255) / 255, num(parts[2], 255) / 255, alpha]
      } else {
        const [r, g, b] = hslToRgb(parseFloat(parts[0]), num(parts[1]), num(parts[2]))
        out = [r, g, b, alpha]
      }
    }
  } else if (NAMED[s]) {
    out = NAMED[s]
  }
  out = out.map((c) => (Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0)) as RGBA
  cache.set(css, out)
  return out
}

/** Premultiplied RGBA with an extra opacity multiplier. */
export function premultiplied(css: string | undefined, opacity = 1): RGBA {
  const [r, g, b, a] = parseColor(css)
  const al = a * opacity
  return [r * al, g * al, b * al, al]
}
