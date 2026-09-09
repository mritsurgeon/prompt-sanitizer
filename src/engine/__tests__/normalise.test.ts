import { describe, expect, it } from 'vitest'
import { scan } from '../detect'
import { normalise } from '../normalise'
import { sanitize } from '../sanitize'

/**
 * Ingestion normalisation.
 *
 * Layer 1 matches exact characters, so anything that changes the characters
 * without changing what a person reads defeats it in silence. Most of that is
 * ordinary text — a non-breaking space in a phone number, a soft hyphen from
 * PDF extraction, a curly quote from a word processor — and some of it is a
 * Cyrillic lookalike in a hostname.
 *
 * The risk in fixing it is not detection, it is the offsets. Detection runs on
 * normalised text; the sanitizer rewrites the user's real document. If a
 * projected offset is wrong, a finding is shown and then silently fails to be
 * removed, which is worse than never finding it. Hence the invariant test at
 * the bottom of this file.
 */

describe('the fast path', () => {
  it('leaves ASCII completely alone', () => {
    const text = 'Email sarah.mitchell@example.com or call +27 82 555 0198.'
    const result = normalise(text)

    expect(result.changed).toBe(false)
    // Same reference: most documents are ASCII, and the expensive path must
    // not run for them.
    expect(result.text).toBe(text)
    expect(result.project(6, 32)).toEqual([6, 32])
  })

  it('reports no change when nothing needed changing, despite non-ASCII', () => {
    // Accented text is non-ASCII but already normalised and holds no
    // confusables, so it must not be reported as obfuscated.
    const result = normalise('Café renovations by José')
    expect(result.changed).toBe(false)
  })
})

describe('what it removes and folds', () => {
  it.each([
    ['zero-width space', 'a​b', 'ab'],
    ['zero-width non-joiner', 'a‌b', 'ab'],
    ['zero-width joiner', 'a‍b', 'ab'],
    ['word joiner', 'a⁠b', 'ab'],
    ['BOM', 'a﻿b', 'ab'],
    ['soft hyphen', 'a­b', 'ab'],
  ])('strips %s', (_name, input, expected) => {
    expect(normalise(input).text).toBe(expected)
  })

  it.each([
    ['Cyrillic a', 'pаypal', 'paypal'],
    ['Cyrillic e o c', 'еос', 'eoc'],
    ['Greek omicron', 'gοogle', 'google'],
    ['en dash', 'a–b', 'a-b'],
    ['em dash', 'a—b', 'a-b'],
    ['minus sign', 'a−b', 'a-b'],
    ['curly apostrophe', "a’b", "a'b"],
    ['curly quotes', '“ab”', '"ab"'],
  ])('folds %s', (_name, input, expected) => {
    expect(normalise(input).text).toBe(expected)
  })

  /**
   * These are NFKC's job, not the table's. Asserted so the dependency is
   * explicit: the obvious first draft of a fold table lists all of them, and
   * every one of those entries would be dead weight.
   */
  it.each([
    ['full-width digits', '０１９', '019'],
    ['full-width letters', 'ａｂ', 'ab'],
    ['mathematical bold', '\u{1D400}\u{1D401}', 'AB'],
    ['non-breaking space', 'a b', 'a b'],
    ['narrow no-break space', 'a b', 'a b'],
    ['fi ligature', 'ﬁle', 'file'],
  ])('relies on NFKC for %s', (_name, input, expected) => {
    expect(normalise(input).text).toBe(expected)
  })

  it('composes across combining marks, which a per-character loop cannot', () => {
    // 'e' + U+0301 is two characters that normalise to one. A loop over
    // characters calling normalize() on each would produce 'e' + U+0301
    // unchanged, so this is the test that the iteration granularity is right.
    const result = normalise('café')
    expect(result.text).toBe('café')
    expect(result.text).toHaveLength(4)
  })
})

describe('projection back to the original', () => {
  it('maps through a deletion', () => {
    const raw = 'ab​cd'
    const { text, project } = normalise(raw)
    expect(text).toBe('abcd')

    // 'bc' in normalised space spans the stripped character in the original.
    const [start, end] = project(1, 3)
    expect(raw.slice(start, end)).toBe('b​c')
  })

  it('maps through an expansion', () => {
    const raw = 'xﬁy' // one ligature character becomes two
    const { text, project } = normalise(raw)
    expect(text).toBe('xfiy')

    // Both halves of 'fi' came from the same original character, so either
    // projects to it whole.
    expect(project(1, 3)).toEqual([1, 2])
    expect(raw.slice(...project(1, 3))).toBe('ﬁ')
  })

  it('maps through a contraction', () => {
    const raw = 'xéy' // two characters become one
    const { text, project } = normalise(raw)
    expect(text).toBe('xéy')

    const [start, end] = project(1, 2)
    expect(raw.slice(start, end)).toBe('é')
  })

  it('is total — bad input clamps rather than throwing', () => {
    const { project } = normalise('a​b')
    // A detector producing an out-of-range span is a bug, and it must not
    // become a crash in somebody's document.
    expect(() => project(-5, 999)).not.toThrow()
    const [start, end] = project(-5, 999)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThanOrEqual(start)
    expect(project(2, 1)[0]).toBeLessThanOrEqual(project(2, 1)[1])
  })
})

describe('detection through obfuscation', () => {
  it.each([
    ['zero-width inside an email', 'Contact sarah.mitchell@exa​mple.com now', 'EMAIL'],
    ['soft hyphen inside an email', 'Contact sarah.mit­chell@example.com now', 'EMAIL'],
    ['non-breaking spaces in a phone number', 'Call +27 82 555 0198 today', 'PHONE'],
    ['full-width phone number', 'Call ＋２７８２５５５０１９８ today', 'PHONE'],
    ['en dashes in a card number', 'Card 4111–1111–1111–1111 expires', 'CREDIT_CARD'],
    ['curly quotes around a password', "config: password=‘Hunter2Hunter2’ here", 'PASSWORD'],
    ['Cyrillic in an internal hostname', 'Server jirа.acme.internal is down', 'INTERNAL_HOST'],
    ['Cyrillic in an AWS key', 'key AKIАIOSFODNN7EXAMPLE rotated', 'API_KEY'],
  ])('finds %s', (_name, text, category) => {
    const result = scan(text)
    expect(result.normalised).toBe(true)
    expect(result.findings.map((f) => f.category)).toContain(category)
  })

  it('does not claim to have normalised plain text', () => {
    expect(scan('Email sarah.mitchell@example.com about CASE-49281.').normalised).toBe(false)
  })
})

describe('the invariant everything downstream depends on', () => {
  const OBFUSCATED = [
    'Contact sarah.mitchell@exa​mple.com now',
    'Call +27 82 555 0198 today',
    'Card 4111–1111–1111–1111 expires',
    "config: password=‘Hunter2Hunter2’ here",
    'Server jirа.acme.internal is down',
    'key AKIАIOSFODNN7EXAMPLE rotated',
    'Contact sarah.mit­chell@example.com and jirа.acme.internal',
  ]

  it.each(OBFUSCATED)('offsets index the original document: %s', (raw) => {
    for (const finding of scan(raw).findings) {
      // The Word writer maps offsets into runs, the highlighter draws on the
      // original, and the sanitizer replaces by value. All three break if
      // this does not hold, and they break quietly.
      expect(raw.slice(finding.start, finding.end)).toBe(finding.value)
    }
  })

  it.each(OBFUSCATED)('cleaning actually removes it: %s', (raw) => {
    const result = scan(raw)
    expect(result.findings.length).toBeGreaterThan(0)

    const cleaned = sanitize(raw, result.findings, { mode: 'redact' })
    // Re-scan the cleaned copy: a finding that was shown and then failed to be
    // removed is the one outcome worse than not finding it at all.
    const residual = scan(cleaned.text).findings.filter(
      (f) => !f.value.startsWith('['),
    )
    expect(residual).toHaveLength(0)
  })
})

describe('normalisation stays linear', () => {
  it('does not blow up on non-ASCII documents', () => {
    // The fast path covers ASCII, so the scaling that matters is the slow one.
    const unit =
      'Contact sarah.mit­chell@exa​mple.com about jirа.acme.internal. ' +
      'Café renovations, “quoted”, 4111–1111–1111–1111. '
    const small = unit.repeat(200)
    const large = unit.repeat(800)

    const time = (text: string) => {
      const started = performance.now()
      for (let i = 0; i < 3; i++) normalise(text)
      return (performance.now() - started) / 3
    }

    time(small) // warm
    const t1 = time(small)
    const t4 = time(large)

    // A scaling assertion rather than a millisecond ceiling, for the same
    // reason as `performance.test.ts`: a stopwatch measures the machine as
    // much as the code.
    expect(t4).toBeLessThan(t1 * 12)
  })
})
