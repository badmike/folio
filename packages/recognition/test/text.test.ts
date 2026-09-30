import { describe, expect, it } from 'vitest'
import { cleanRecognizedText, detectLanguage, guessSemanticType, recognitionId } from '../src/text'

describe('detectLanguage', () => {
  it('detects German by umlauts and stop words', () => {
    expect(detectLanguage('Übung zur Vorlesung')).toBe('de')
    expect(detectLanguage('Das ist ein Beispiel')).toBe('de')
    expect(detectLanguage('Straße')).toBe('de')
  })
  it('defaults to English', () => {
    expect(detectLanguage('The result is not important')).toBe('en')
    expect(detectLanguage('xyz')).toBe('en')
  })
  it('respects the allowed language list', () => {
    expect(detectLanguage('Das ist ein Test', ['en'])).toBe('en')
    expect(detectLanguage('hello', ['de'])).toBe('de')
  })
})

describe('recognitionId', () => {
  it('is deterministic and order independent', () => {
    expect(recognitionId(['a', 'b', 'c'])).toBe(recognitionId(['c', 'a', 'b']))
    expect(recognitionId(['a', 'b'])).toMatch(/^rec_[0-9a-f]{16}$/)
  })
  it('differs for different sets', () => {
    expect(recognitionId(['a', 'b'])).not.toBe(recognitionId(['a', 'c']))
    expect(recognitionId(['ab', 'c'])).not.toBe(recognitionId(['a', 'bc']))
  })
})

describe('guessSemanticType', () => {
  it('detects list items and headings', () => {
    expect(guessSemanticType('- milk', { height: 30 }, 30)).toBe('list-item')
    expect(guessSemanticType('• eggs', { height: 30 }, 30)).toBe('list-item')
    expect(guessSemanticType('2. second', { height: 30 }, 30)).toBe('list-item')
    expect(guessSemanticType('Big Title', { height: 70 }, 30)).toBe('heading')
    expect(guessSemanticType('normal text', { height: 32 }, 30)).toBeUndefined()
    expect(guessSemanticType('3.14 is pi', { height: 30 }, 30)).toBeUndefined()
  })
})

describe('cleanRecognizedText', () => {
  it('strips OCR noise and collapses whitespace', () => {
    expect(cleanRecognizedText('| hello  ~world_ .')).toBe('hello world')
    expect(cleanRecognizedText('"Einkaufen\n morgen\' -')).toBe('Einkaufen morgen')
    expect(cleanRecognizedText('^todo `')).toBe('todo')
  })
  it('keeps real punctuation, bullets and inner apostrophes', () => {
    expect(cleanRecognizedText('Done. Why? Yes!')).toBe('Done. Why? Yes!')
    expect(cleanRecognizedText('Note: milk, eggs')).toBe('Note: milk, eggs')
    expect(cleanRecognizedText('- milk')).toBe('- milk')
    expect(cleanRecognizedText('Berlin - Paris')).toBe('Berlin - Paris')
  })
  it('normalises quote and dash variants', () => {
    expect(cleanRecognizedText('don´t – it’s „gut“')).toBe('don\'t - it\'s "gut"')
  })
  it('returns empty text for symbol-only results', () => {
    expect(cleanRecognizedText(' |~ . -- \' ')).toBe('')
    expect(cleanRecognizedText('')).toBe('')
  })
})
