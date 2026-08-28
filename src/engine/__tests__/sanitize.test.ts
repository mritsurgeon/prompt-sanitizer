import { describe, expect, it } from 'vitest'
import { scan } from '../detect'
import { sanitize } from '../sanitize'
import type { SanitizeMode } from '../types'

/**
 * The sanitizer works from the findings the detector produced and the user
 * approved — there is no second detection pass — so these tests pin the
 * contract between the two.
 */

const SAMPLE =
  'Contact Sarah Mitchell on sarah.mitchell@example.com or +27 82 555 0198 about CASE-49281. The key is sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b.'

const clean = (mode: SanitizeMode, text = SAMPLE) => {
  const result = scan(text)
  return sanitize(text, result.findings, { mode })
}

describe('cleaning modes', () => {
  it('redacts to category placeholders', () => {
    const { text } = clean('redact')
    expect(text).toContain('[PERSON_NAME]')
    expect(text).toContain('[EMAIL]')
    expect(text).not.toContain('Sarah Mitchell')
  })

  it('pseudonymises consistently', () => {
    const { text } = clean(
      'pseudonymize',
      'Sarah Mitchell called. Later Sarah Mitchell emailed again.',
    )
    const matches = text.match(/Person_\d{3}/g) ?? []
    expect(matches).toHaveLength(2)
    expect(new Set(matches).size).toBe(1)
  })

  it('produces synthetic values from documentation-only ranges', () => {
    const { text } = clean('synthetic')
    expect(text).toMatch(/@example\.com/)
    expect(text).not.toContain('sarah.mitchell@example.com')
  })

  it('keeps the same stand-in for the same value across categories', () => {
    const { valueMap } = clean(
      'synthetic',
      'Email a@example.com twice: a@example.com.',
    )
    expect(valueMap.size).toBe(1)
  })
})

describe('secrets are special', () => {
  it.each(['redact', 'pseudonymize', 'synthetic'] as SanitizeMode[])(
    'removes credentials outright in %s mode',
    (mode) => {
      const { text } = clean(mode)
      expect(text).toContain('[REMOVED_SECRET]')
      expect(text).not.toContain('sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b')
    },
  )
})

describe('user decisions are final', () => {
  it('does not replace a finding the user disabled', () => {
    const result = scan(SAMPLE)
    const findings = result.findings.map((f) =>
      f.category === 'PERSON' ? { ...f, enabled: false } : f,
    )
    const { text, replacements } = sanitize(SAMPLE, findings, { mode: 'redact' })

    expect(text).toContain('Sarah Mitchell')
    expect(replacements.some((r) => r.finding.category === 'PERSON')).toBe(false)
    // Everything else still goes.
    expect(text).toContain('[EMAIL]')
  })

  it('replaces nothing when everything is disabled', () => {
    const result = scan(SAMPLE)
    const findings = result.findings.map((f) => ({ ...f, enabled: false }))
    const { text } = sanitize(SAMPLE, findings, { mode: 'redact' })
    expect(text).toBe(SAMPLE)
  })

  it('honours overrides for every risk dimension', () => {
    const text =
      'Project Phoenix is led by Sarah Mitchell. Server SQL-PROD-04. Key sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b.'
    const result = scan(text)

    for (const category of [
      'PROJECT_CODE',
      'PERSON',
      'INTERNAL_HOST',
      'API_KEY',
    ] as const) {
      const target = result.findings.find((f) => f.category === category)
      if (!target) continue

      const findings = result.findings.map((f) =>
        f.id === target.id ? { ...f, enabled: false } : f,
      )
      const cleaned = sanitize(text, findings, { mode: 'redact' })
      expect(cleaned.text).toContain(target.value)
    }
  })
})

describe('detector and sanitizer agree', () => {
  it('can locate and replace every finding it reports', () => {
    const result = scan(SAMPLE)
    const cleaned = sanitize(SAMPLE, result.findings, { mode: 'redact' })

    // One replacement per enabled finding — nothing silently unreplaceable.
    expect(cleaned.replacements).toHaveLength(result.findings.length)
    for (const replacement of cleaned.replacements) {
      expect(cleaned.text.slice(replacement.start, replacement.end)).toBe(
        replacement.replacement,
      )
    }
  })

  it('leaves the original text untouched', () => {
    const before = SAMPLE
    clean('redact')
    expect(SAMPLE).toBe(before)
  })

  it('drops the risk score to near zero on a real re-scan', () => {
    const result = scan(SAMPLE)
    const cleaned = sanitize(SAMPLE, result.findings, { mode: 'redact' })
    const ours = new Set(cleaned.replacements.map((r) => r.replacement))
    const residual = scan(cleaned.text).findings.filter(
      (f) => !ours.has(f.value),
    )

    expect(result.risk.score).toBeGreaterThan(60)
    expect(residual).toHaveLength(0)
  })
})
