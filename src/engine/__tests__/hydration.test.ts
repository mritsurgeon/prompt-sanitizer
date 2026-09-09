import { describe, expect, it } from 'vitest'
import { scan } from '../detect'
import { HydrationVault } from '../hydration/vault'
import { sanitize } from '../sanitize'

/**
 * Putting the real values back.
 *
 * Cleaning solves half a problem and creates the other half: mask the names,
 * ask for a draft, and the model returns a letter addressed to `Person_001`.
 * The user repairs it by hand and learns not to clean anything. So the
 * substitutions are remembered for a conversation and the answer is restored
 * locally.
 *
 * Four things can go wrong, and each has a test below: a token can be restored
 * inside a longer token, a credential can come back, a stand-in can drift
 * between turns, and an ambiguous token can be restored to the wrong value.
 */

const SESSION = 'tab-7:chat-abc'

function clean(text: string, mode: 'redact' | 'pseudonymize' | 'synthetic', vault?: HydrationVault) {
  const result = scan(text)
  return sanitize(text, result.findings, {
    mode,
    carry: vault?.carryFor(SESSION),
  })
}

describe('only unique stand-ins can be reversed', () => {
  it('restores nickname mode', () => {
    const vault = new HydrationVault()
    const text = 'Email sarah.mitchell@example.com and david.okafor@example.com today'

    const cleaned = clean(text, 'pseudonymize', vault)
    vault.record(SESSION, cleaned)

    // What the model would hand back, referring to the stand-ins.
    const answer = `I have drafted a note to ${cleaned.valueMap.get('sarah.mitchell@example.com')} and copied ${cleaned.valueMap.get('david.okafor@example.com')}.`
    const { text: hydrated, restored } = vault.hydrate(SESSION, answer)

    expect(restored).toBe(2)
    expect(hydrated).toContain('sarah.mitchell@example.com')
    expect(hydrated).toContain('david.okafor@example.com')
  })

  it('refuses redact mode, because its tokens are many-to-one', () => {
    const vault = new HydrationVault()
    const text = 'Email sarah.mitchell@example.com and david.okafor@example.com today'

    const cleaned = clean(text, 'redact', vault)
    // Both addresses became the same `[EMAIL]`. This is the mode that looks
    // safest to invert and is the one that cannot be.
    expect(cleaned.text).toBe('Email [EMAIL] and [EMAIL] today')

    vault.record(SESSION, cleaned)
    const { text: hydrated, restored } = vault.hydrate(
      SESSION,
      'I have drafted a note to [EMAIL].',
    )

    // Nothing restored is the correct answer. Guessing one of the two would be
    // worse than leaving it alone.
    expect(restored).toBe(0)
    expect(hydrated).toContain('[EMAIL]')
    expect(vault.restorable(SESSION)).toHaveLength(0)
  })

  it('restores a single value even in redact mode, where it is unambiguous', () => {
    const vault = new HydrationVault()
    const cleaned = clean('Email sarah.mitchell@example.com today', 'redact', vault)
    vault.record(SESSION, cleaned)

    const { restored } = vault.hydrate(SESSION, 'Sent to [EMAIL].')
    expect(restored).toBe(1)
  })
})

describe('token boundaries', () => {
  const vault = new HydrationVault()

  it('does not restore a token inside a longer one', () => {
    // The failure the longest-first ordering exists to prevent. With the short
    // token first in the alternation, `Person_0010` is left untouched: the
    // engine matches `Person_001`, the trailing boundary fails on the `0`, and
    // it abandons the position instead of trying the longer branch.
    vault.record('boundaries', {
      pseudonyms: { assigned: new Map(), used: new Set(), counters: new Map() },
      replacements: [
        {
          finding: { value: 'Jane Doe', category: 'PERSON' },
          replacement: 'Person_001',
        },
        {
          finding: { value: 'Ada Lovelace', category: 'PERSON' },
          replacement: 'Person_0010',
        },
      ] as never,
    })

    const { text } = vault.hydrate('boundaries', 'Person_0010 met Person_001 today')
    expect(text).toBe('Ada Lovelace met Jane Doe today')
  })

  it.each([
    ["See Person_001's report.", "See Jane Doe's report."],
    ['(Person_001)', '(Jane Doe)'],
    ['Person_001, who approved it', 'Jane Doe, who approved it'],
    ['ask Person_001.', 'ask Jane Doe.'],
  ])('handles punctuation around %s', (input, expected) => {
    const local = new HydrationVault()
    local.record('punct', {
      pseudonyms: { assigned: new Map(), used: new Set(), counters: new Map() },
      replacements: [
        { finding: { value: 'Jane Doe', category: 'PERSON' }, replacement: 'Person_001' },
      ] as never,
    })
    expect(local.hydrate('punct', input).text).toBe(expected)
  })

  it('does not restore a token that is part of a longer word', () => {
    const local = new HydrationVault()
    local.record('word', {
      pseudonyms: { assigned: new Map(), used: new Set(), counters: new Map() },
      replacements: [
        { finding: { value: 'Jane Doe', category: 'PERSON' }, replacement: 'Person_001' },
      ] as never,
    })
    expect(local.hydrate('word', 'the Person_001s column').restored).toBe(0)
  })

  it('restores a bracketed placeholder, which needs no word boundary', () => {
    // A single pattern with `\b` on both ends matches nothing here: before the
    // `[`, preceded by a space, there is no word/non-word transition. That bug
    // is silent — placeholder mode would simply never restore anything.
    const local = new HydrationVault()
    local.record('bracket', {
      pseudonyms: { assigned: new Map(), used: new Set(), counters: new Map() },
      replacements: [
        { finding: { value: 'a@example.com', category: 'EMAIL' }, replacement: '[EMAIL]' },
      ] as never,
    })
    expect(local.hydrate('bracket', 'Contact [EMAIL] today').text).toBe(
      'Contact a@example.com today',
    )
  })
})

describe('a credential never comes back', () => {
  it('is refused by the category group, not by the category name', () => {
    const vault = new HydrationVault()
    const text =
      'Use key AKIAIOSFODNN7EXAMPLE with password = S3cur3!P@ssw0rd#2024x on jira.corp.internal'

    const cleaned = clean(text, 'pseudonymize', vault)
    vault.record(SESSION, cleaned)

    const secrets = cleaned.replacements.filter((r) =>
      ['API_KEY', 'PASSWORD', 'ACCESS_TOKEN', 'CONNECTION_STRING'].includes(
        r.finding.category,
      ),
    )
    expect(secrets.length).toBeGreaterThan(0)

    // The point of stripping a key is that it stops existing in the
    // conversation. `PASSWORD` and `ACCESS_TOKEN` contain neither "secret" nor
    // "key", so a guard that looks for those words in the category name lets
    // them straight through — hence the check against the category table.
    for (const secret of secrets) {
      const { text: back } = vault.hydrate(SESSION, `token ${secret.replacement} here`)
      expect(back).not.toContain(secret.finding.value)
    }

    // Non-secrets in the same prompt are still restorable.
    const host = cleaned.replacements.find((r) => r.finding.category === 'INTERNAL_HOST')
    expect(host).toBeDefined()
    if (host) {
      expect(vault.hydrate(SESSION, host.replacement).text).toBe('jira.corp.internal')
    }
  })
})

describe('stand-ins hold across turns', () => {
  it('reuses the same nickname for the same person', () => {
    const vault = new HydrationVault()

    const first = clean('Ask Sarah Mitchell about the renewal', 'pseudonymize', vault)
    vault.record(SESSION, first)
    const firstToken = [...first.valueMap.values()][0]

    // A second turn mentioning the same person and one more.
    const second = clean(
      'Sarah Mitchell and David Okafor both approved it',
      'pseudonymize',
      vault,
    )
    vault.record(SESSION, second)

    // Turn two must say the same thing about the same person, or the model
    // loses track of who is who — which is the whole reason nickname mode
    // exists.
    expect(second.valueMap.get('Sarah Mitchell')).toBe(firstToken)
    // And the newcomer must not be handed a stand-in that is already taken.
    expect(second.valueMap.get('David Okafor')).not.toBe(firstToken)
  })

  it('does not mutate the carried state of a discarded result', () => {
    const vault = new HydrationVault()
    const before = clean('Ask Sarah Mitchell about it', 'pseudonymize', vault)
    vault.record(SESSION, before)
    const size = vault.carryFor(SESSION).assigned.size

    // Sanitize, then throw the result away without recording it.
    clean('Ask David Okafor about it', 'pseudonymize', vault)

    // The vault must be unchanged: a caller that discards a result should not
    // find its own state already modified.
    expect(vault.carryFor(SESSION).assigned.size).toBe(size)
  })

  it('keeps sessions apart', () => {
    const vault = new HydrationVault()
    const a = sanitize('Ask Sarah Mitchell', scan('Ask Sarah Mitchell').findings, {
      mode: 'pseudonymize',
      carry: vault.carryFor('tab-1'),
    })
    vault.record('tab-1', a)

    // A prompt in one tab must not restore against another tab's map.
    const token = [...a.valueMap.values()][0]
    expect(vault.hydrate('tab-2', token).restored).toBe(0)
    expect(vault.hydrate('tab-1', token).restored).toBe(1)
  })
})

describe('lifetime', () => {
  it('evicts a session on request', () => {
    const vault = new HydrationVault()
    const cleaned = clean('Ask Sarah Mitchell', 'pseudonymize', vault)
    vault.record(SESSION, cleaned)
    expect(vault.restorable(SESSION).length).toBeGreaterThan(0)

    vault.evict(SESSION)
    expect(vault.restorable(SESSION)).toHaveLength(0)
  })

  it('is bounded, so a worker that never sees a tab close cannot grow forever', () => {
    const vault = new HydrationVault(4)
    for (let i = 0; i < 20; i++) vault.session(`tab-${i}`)
    expect(vault.size).toBeLessThanOrEqual(4)
  })
})
