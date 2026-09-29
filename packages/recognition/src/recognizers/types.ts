import type { InkStroke } from '@folio/document'
import type { HandwritingRecognizer, HandwritingResult } from '../contract'

export interface RecognizeOpts {
  languages: string[]
  /** Hint about the group granularity (selects e.g. Tesseract page-segmentation mode). */
  mode?: 'word' | 'line' | 'block'
}

/** Result that also reports which concrete recognizer produced it (used by the composite). */
export interface HandwritingResultEx extends HandwritingResult {
  recognizer?: string
}

export interface LocalRecognizer extends HandwritingRecognizer {
  recognize(strokes: InkStroke[], opts: RecognizeOpts): Promise<HandwritingResultEx | null>
}

/** Absolute URL (workers need absolute paths for Tesseract's importScripts). */
export function absoluteUrl(path: string): string {
  const loc = (globalThis as { location?: { href?: string } }).location
  try {
    return loc?.href ? new URL(path, loc.href).href : path
  } catch {
    return path
  }
}

export function joinUrl(base: string, rel: string): string {
  return base.replace(/\/+$/, '') + '/' + rel.replace(/^\/+/, '')
}

/** 'en' -> 'eng', 'de' -> 'deu' (Tesseract codes); unknown codes pass through. */
export function toTesseractLang(l: string): string {
  const m: Record<string, string> = { en: 'eng', de: 'deu', eng: 'eng', deu: 'deu' }
  return m[l.toLowerCase().split('-')[0]] ?? l
}
