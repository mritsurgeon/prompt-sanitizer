import { describe, expect, it } from 'vitest'
import { scan } from '../detect'
import { category } from '../categories'
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

describe('a credential in a spreadsheet cell', () => {
  const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  const secretsIn = (text: string) =>
    scan(text).findings.filter((f) => category(f.category).group === 'secret')

  /**
   * A spreadsheet is not source code.
   *
   * `AWS secret key` in one cell and the key in the next reaches the engine
   * as `AWS secret key | wJalr…`, and the assignment rule missed it twice
   * over: it spelled the label `secret[_-]?key`, which does not allow the
   * space, and it accepted `is`, `:`, `=` and `=>` as separators but not the
   * `|` that `extractFile` joins columns with. Either alone would have been
   * enough to lose it.
   *
   * It looked like it worked because `secret_key = …` always matched — the
   * form a test writes and a spreadsheet never produces.
   */
  it('finds one behind a column separator', () => {
    expect(secretsIn(`AWS secret key | ${AWS_SECRET}`)).toHaveLength(1)
  })

  it('finds one behind a tab, which is what a .tsv gives', () => {
    expect(secretsIn(`api key\t${AWS_SECRET}`)).toHaveLength(1)
  })

  it.each([
    'AWS secret key',
    'secret key',
    'secret access key',
    'api key',
    'client secret',
  ])('reads "%s" as a credential label', (label) => {
    expect(secretsIn(`${label} = ${AWS_SECRET}`)).toHaveLength(1)
  })

  it('keeps the value, not the label, as the finding', () => {
    // The label is in the pattern but outside the capture. A finding that
    // swallowed `AWS secret key | ` would redact the header too, and in a
    // spreadsheet the header is how the reader knows what the column was.
    const [found] = secretsIn(`AWS secret key | ${AWS_SECRET}`)
    expect(found.value).toBe(AWS_SECRET)
  })

  it('takes a value containing ~, as Azure client secrets do', () => {
    // An unquoted value stops at the first character outside the set, so
    // omitting `~` did not shorten the match — it lost it entirely.
    expect(secretsIn('client secret | Q~8xN2vKp4mZ1rT6yW9bE3aH5jL7nC0dF')).toHaveLength(1)
  })

  /**
   * Allowing a space in the label widens it into ordinary prose, where
   * "the secret key is" now matches the pattern. What stops that becoming a
   * false positive is the validator, not the pattern — the same validator
   * that already had to reject `api_key = changeme`.
   */
  it.each([
    'The secret key is stored in the vault, not in the repo.',
    'Please rotate the api key before Friday.',
    'Your access token has expired; sign in again.',
    'Ask Sarah whether the client secret is documented anywhere.',
    'secret key | see the password manager',
    'Column headers: Field | Value | Notes',
  ])('does not fire on prose: %s', (line) => {
    expect(secretsIn(line)).toHaveLength(0)
  })

  it('no longer shreds the key into name candidates', () => {
    // Undetected, the key was three capitalised fragments — `JalrXUtnFEMI`,
    // `MDENG`, `PxRfiCYEXAMPLEKEY` — offered as possible people. Claiming a
    // span as a secret is what stops the entity layer guessing at it.
    const { recoverable } = scan(`AWS secret key | ${AWS_SECRET}`)
    expect(recoverable.filter((r) => AWS_SECRET.includes(r.value))).toHaveLength(0)
  })
})
