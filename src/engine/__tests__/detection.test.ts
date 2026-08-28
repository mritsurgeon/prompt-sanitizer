import { describe, expect, it } from 'vitest'
import { scan } from '../detect'
import { ALL_CASES, type Case } from './corpus'

/**
 * The false-positive regression suite.
 *
 * `reject` entries are the traps: ordinary language that looks like an entity.
 * `expect` entries are the regression guard — the price of rejecting noise must
 * not be missing real sensitive data.
 */

const findingsFor = (text: string) => scan(text).findings

function flagged(text: string, value: string) {
  return findingsFor(text).find(
    (f) => f.value === value || f.value.includes(value),
  )
}

describe.each(ALL_CASES)('$group', ({ cases }) => {
  const withRejects = cases.filter((c): c is Case => Boolean(c.reject?.length))
  const withExpects = cases.filter((c): c is Case => Boolean(c.expect?.length))

  if (withRejects.length) {
    describe('does not flag ordinary language', () => {
      it.each(withRejects)('$name', (testCase) => {
        for (const trap of testCase.reject ?? []) {
          const hit = flagged(testCase.text, trap)
          expect(
            hit,
            `expected not to flag ${JSON.stringify(trap)} but got ${hit?.category}:${JSON.stringify(hit?.value)} via "${hit?.rule}"`,
          ).toBeUndefined()
        }
      })
    })
  }

  if (withExpects.length) {
    describe('still finds real sensitive data', () => {
      it.each(withExpects)('$name', (testCase) => {
        const findings = findingsFor(testCase.text)
        for (const wanted of testCase.expect ?? []) {
          const hit = findings.find(
            (f) =>
              f.value === wanted.value &&
              (!wanted.category || f.category === wanted.category),
          )
          expect(
            hit,
            `expected ${wanted.category ?? 'a finding'} ${JSON.stringify(wanted.value)}, saw ${JSON.stringify(findings.map((f) => `${f.category}:${f.value}`))}`,
          ).toBeDefined()
        }
      })
    })
  }
})

describe('aggregate quality gates', () => {
  const all = ALL_CASES.flatMap(({ cases }) => cases)

  it('has no false positives across the whole corpus', () => {
    const failures: string[] = []
    for (const testCase of all) {
      for (const trap of testCase.reject ?? []) {
        const hit = flagged(testCase.text, trap)
        if (hit) failures.push(`${testCase.name}: ${hit.category}:${hit.value}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('has no false negatives across the whole corpus', () => {
    const failures: string[] = []
    for (const testCase of all) {
      const findings = findingsFor(testCase.text)
      for (const wanted of testCase.expect ?? []) {
        const found = findings.some(
          (f) =>
            f.value === wanted.value &&
            (!wanted.category || f.category === wanted.category),
        )
        if (!found) failures.push(`${testCase.name}: ${wanted.value}`)
      }
    }
    expect(failures).toEqual([])
  })
})

describe('confidence tiers', () => {
  it('treats structured data as high confidence', () => {
    const findings = findingsFor(
      'Email sarah.mitchell@example.com or call +27 82 555 0198.',
    )
    expect(findings.every((f) => f.tier === 'high')).toBe(true)
  })

  it('treats a context-carried unknown name as uncertain, not certain', () => {
    const findings = findingsFor('Adeyemi confirmed the migration window.')
    const person = findings.find((f) => f.category === 'PERSON')
    expect(person?.tier).toBe('medium')
  })

  it('records the evidence for and against every finding', () => {
    const findings = findingsFor('Christian joined the meeting yesterday.')
    const person = findings.find((f) => f.category === 'PERSON')

    expect(person).toBeDefined()
    expect(person!.signals.length).toBeGreaterThan(0)
    // Both directions must be represented, not just supporting evidence.
    expect(person!.signals.some((s) => s.weight > 0)).toBe(true)
    expect(person!.signals.some((s) => s.weight < 0)).toBe(true)
    // And every signal must be explainable in plain English.
    expect(person!.signals.every((s) => s.note.length > 0)).toBe(true)
  })

  it('discards low-confidence candidates rather than showing them', () => {
    const result = scan('Christian values are important to the organisation.')
    expect(result.findings).toHaveLength(0)
  })
})

describe('entity consistency', () => {
  it('reinforces a bare first name using an email in the same content', () => {
    const alone = findingsFor('Christian will pick this up.')
    const corroborated = findingsFor(
      "Christian will pick this up. Christian's email is christian@example.com.",
    )

    const scoreOf = (findings: ReturnType<typeof findingsFor>) =>
      findings.find((f) => f.category === 'PERSON')?.confidence ?? 0

    expect(scoreOf(corroborated)).toBeGreaterThan(scoreOf(alone))
  })

  it('applies one confident mention to the other mentions of the same value', () => {
    const findings = findingsFor(
      'Sarah Mitchell raised the case. Later, Sarah asked for an update.',
    )
    const people = findings.filter((f) => f.category === 'PERSON')
    expect(people.length).toBeGreaterThanOrEqual(2)
    expect(people.every((p) => p.tier === 'high')).toBe(true)
  })
})
