import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAllowlist,
  digestFor,
  isAllowed,
  loadAllowlist,
  normaliseValue,
  registerAllowlist,
  resetAllowlist,
  suppressAllowed,
} from '../allowlist'
import { sha256Hex } from '../allowlist/sha256'
import { scan } from '../detect'

/**
 * The allowlist.
 *
 * This is a precision feature and precision here is what keeps the tool
 * installed: a user's own name and email appear in almost everything they
 * write, and warning about them on every prompt is the fastest route to
 * somebody switching the extension off.
 *
 * The property that matters most is the one at the bottom of this file - an
 * allowlist must never be able to silence a credential, whatever somebody puts
 * in it.
 */

const SALT = 'test-salt-1234'
const SELF = 'Ian Engelbrecht'
const SELF_EMAIL = 'ian.engelbrecht@acme.example'

afterEach(() => {
  resetAllowlist()
})

describe('the digest', () => {
  it('matches the standard SHA-256 vectors', () => {
    // A hand-rolled hash that is subtly wrong would silently stop matching
    // anything, and the allowlist would look like it was merely not working.
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    )
  })

  it('normalises both sides identically', () => {
    expect(normaliseValue('  Ian   Engelbrecht ')).toBe('ian engelbrecht')
    expect(digestFor('  IAN  Engelbrecht ', SALT)).toBe(digestFor('ian engelbrecht', SALT))
  })

  it('is salted, so an exported list is not a dictionary lookup', () => {
    // The salt is the load-bearing part. An unsalted digest of a name is just
    // a lookup in a list of names.
    expect(digestFor(SELF, 'salt-a')).not.toBe(digestFor(SELF, 'salt-b'))
  })

  it('refuses malformed entries when loading digests', () => {
    const loaded = loadAllowlist({
      salt: SALT,
      valueDigests: [digestFor(SELF, SALT), 'not-a-digest', '', 'ABCD'],
    })
    expect(loaded.values.size).toBe(1)
  })

  it('accepts digests case-insensitively', () => {
    const loaded = loadAllowlist({
      salt: SALT,
      valueDigests: [digestFor(SELF, SALT).toUpperCase()],
    })
    expect(isAllowed({ value: SELF, category: 'PERSON' }, loaded)).toBe(true)
  })
})

describe('suppressing an identity', () => {
  const allowlist = buildAllowlist({
    salt: SALT,
    values: [SELF, SELF_EMAIL, 'Acme Holdings'],
    domains: ['corp.internal'],
  })

  it('drops the user out of their own signature', () => {
    registerAllowlist(allowlist)
    const result = scan(`Please review the attached.\n\nBest regards,\n${SELF}`)
    expect(result.findings.map((f) => f.value)).not.toContain(SELF)
    expect(result.suppressed).toBeGreaterThan(0)
  })

  it('keeps everybody else in a recipient list', () => {
    registerAllowlist(allowlist)
    const result = scan(
      `Send it to ${SELF_EMAIL} and thandeka.mokoena@example.com today`,
    )
    const emails = result.findings.filter((f) => f.category === 'EMAIL').map((f) => f.value)
    // The whole point: silence about *me*, not about everybody.
    expect(emails).not.toContain(SELF_EMAIL)
    expect(emails).toContain('thandeka.mokoena@example.com')
  })

  it('covers subdomains of an allowed domain', () => {
    registerAllowlist(allowlist)
    // A suffix test cannot run against a hash, so the candidate is decomposed
    // and each of its own suffixes is hashed instead.
    for (const host of ['api.corp.internal', 'jira.eu.corp.internal', 'corp.internal']) {
      expect(isAllowed({ value: host, category: 'INTERNAL_HOST' }, allowlist)).toBe(true)
    }
  })

  it('does not cover a domain that merely ends in the same letters', () => {
    expect(
      isAllowed({ value: 'evilcorp.internal', category: 'INTERNAL_HOST' }, allowlist),
    ).toBe(false)
    expect(
      isAllowed({ value: 'notcorp.internal', category: 'INTERNAL_HOST' }, allowlist),
    ).toBe(false)
  })

  it('suppresses an email by its domain, not only by its address', () => {
    expect(
      isAllowed({ value: 'someone.else@api.corp.internal', category: 'EMAIL' }, allowlist),
    ).toBe(true)
    expect(
      isAllowed({ value: 'someone.else@other.example', category: 'EMAIL' }, allowlist),
    ).toBe(false)
  })

  it('does not suppress a hostname that merely contains an allowed name', () => {
    // Allowlisting `Acme Holdings` must not silence internal infrastructure.
    // It cannot, because matching is on a candidate's whole value and never a
    // substring.
    expect(
      isAllowed({ value: 'jira.acme.internal', category: 'INTERNAL_HOST' }, allowlist),
    ).toBe(false)
  })

  it('leaves unrelated names alone', () => {
    for (const name of ['Thandeka Mokoena', 'Grace', 'Acme Logistics']) {
      expect(isAllowed({ value: name, category: 'PERSON' }, allowlist)).toBe(false)
    }
  })
})

describe('what an allowlist may never do', () => {
  it('cannot silence a credential, whatever is in it', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE'
    const password = 'S3cur3!P@ssw0rd#2024x'
    // Someone who pastes their own key into the allowlist has made a mistake,
    // and the engine must not honour it: a credential is not a matter of
    // personal preference, and this is the thing the tool exists to prevent.
    const reckless = buildAllowlist({ salt: SALT, values: [key, password] })
    registerAllowlist(reckless)

    expect(isAllowed({ value: key, category: 'API_KEY' }, reckless)).toBe(false)
    expect(isAllowed({ value: password, category: 'PASSWORD' }, reckless)).toBe(false)

    const found = scan(`key ${key} rotated, password = ${password}`)
    expect(found.findings.map((f) => f.category)).toContain('API_KEY')
    expect(found.suppressed).toBe(0)
  })

  it('cannot silence a category outside the identity set', () => {
    const reckless = buildAllowlist({ salt: SALT, values: ['CASE-49281', '4111111111111111'] })
    expect(isAllowed({ value: 'CASE-49281', category: 'CASE_ID' }, reckless)).toBe(false)
    expect(
      isAllowed({ value: '4111111111111111', category: 'CREDIT_CARD' }, reckless),
    ).toBe(false)
  })
})

describe('costing nothing when unconfigured', () => {
  it('returns the same array rather than filtering it', () => {
    const candidates = [
      { value: 'Thandeka Mokoena', category: 'PERSON' as const },
    ] as never[]
    const { kept, suppressed } = suppressAllowed(candidates, [])
    // One set-size check for the whole scan, rather than a digest per
    // candidate. The default has to be free.
    expect(kept).toBe(candidates)
    expect(suppressed).toBe(0)
  })

  it('is the default, so nothing is suppressed unless asked', () => {
    const result = scan(`Best regards,\n${SELF}`)
    expect(result.suppressed).toBe(0)
  })
})

describe('suppression happens before anything reads the candidates', () => {
  it('does not let an allowlisted company vote on document sensitivity', () => {
    const text =
      'Contract review for Acme Holdings, Nokia Bell Labs and Meridian ' +
      'Logistics this quarter.'

    // The assessment raises `customer-list` once a document names three or
    // more distinct companies. Three here, so it fires.
    const before = scan(text)
    expect(before.document.signals.map((s) => s.id)).toContain('customer-list')

    registerAllowlist(buildAllowlist({ salt: SALT, values: ['Acme Holdings'] }))
    const after = scan(text)

    // With the user's own employer suppressed there are two, so it must not.
    // This is the whole reason suppression runs at the candidate stage: a
    // filter over findings at the end would have let the allowlisted company
    // vote first and only then been removed from the display.
    expect(after.suppressed).toBe(1)
    expect(after.findings.map((f) => f.value)).not.toContain('Acme Holdings')
    expect(after.document.signals.map((s) => s.id)).not.toContain('customer-list')
  })
})
