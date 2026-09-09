import { describe, expect, it } from 'vitest'
import { scan } from '../detect'
import {
  alphabetSize,
  entropyRatio,
  looksLikePlaceholder,
  looksLikeSecret,
  looksLikeStructuredId,
  looksLikeWords,
  shannonEntropy,
} from '../entropy'

/**
 * Randomness as evidence.
 *
 * These feed a category the policy layer is allowed to **block**, so a false
 * positive here does not annoy somebody — it stops them working. Every
 * threshold below was set by measuring real-shaped credentials against real
 * non-credentials, not by choosing a round number.
 */

describe('an absolute bits-per-character floor cannot work', () => {
  it('is capped by the length of the string', () => {
    // The arithmetic that makes the obvious design inert: a string of length n
    // holds at most n distinct symbols, so per-symbol entropy cannot exceed
    // log2(n). A 16-character value caps at 4.0 bits and a 20-character one at
    // 4.32 — so a "4.5 bits per character" floor rejects everything shorter
    // than 23 characters, including everything that passes a `length >= 16`
    // gate. The rule reads as strict and is in fact unreachable.
    const sixteen = 'abcdefghijklmnop'
    expect(sixteen).toHaveLength(16)
    expect(shannonEntropy(sixteen)).toBeCloseTo(4.0, 5)
    expect(shannonEntropy(sixteen)).toBeLessThan(4.5)

    const twenty = 'abcdefghijklmnopqrst'
    expect(shannonEntropy(twenty)).toBeLessThan(4.5)
  })

  it('normalises to 0..1 so a threshold means the same at every length', () => {
    // Maximum entropy for its length and alphabet, both short and long.
    expect(entropyRatio('abcdefghijklmnop')).toBeCloseTo(1, 5)
    expect(entropyRatio('0123456789abcdef')).toBeCloseTo(1, 5)
    // No entropy at all.
    expect(entropyRatio('aaaaaaaaaaaaaaaa')).toBe(0)
    expect(entropyRatio('')).toBe(0)
    expect(entropyRatio('a')).toBe(0)
  })

  it('infers the source alphabet rather than the observed one', () => {
    // `deadbeef` should be measured against hex, not against the eight
    // characters it happens to use.
    expect(alphabetSize('deadbeef')).toBe(16)
    expect(alphabetSize('0123456789')).toBe(10)
    expect(alphabetSize('aG9tZS9pYW4=')).toBe(64)
    expect(alphabetSize('S3cur3!P@ss')).toBe(94)
  })
})

describe('telling a token from a word', () => {
  it.each([
    'changeme',
    'correcthorsebatterystaple',
    'ProductionDatabase',
    'CustomerContactList',
    'session_key_suffix',
  ])('reads %s as language', (value) => {
    expect(looksLikeWords(value)).toBe(true)
  })

  it.each([
    '9f8e7d6c5b4a3210fedcba9876543210',
    'b7f3c1d9e5a24680b1c3d5e7f9a0b2c4',
    'xK3mP9qR7wL2nZ8vB5cY',
    'aG9tZS9pYW4vLmNvbmZpZw==',
  ])('does not read %s as language', (value) => {
    expect(looksLikeWords(value)).toBe(false)
  })

  it('does not judge vowel structure after throwing the digits away', () => {
    // The first version stripped non-letters before looking at vowels, so
    // `9f8e7d6c5b4a3210` reduced to `fedcba…` — vowels in all the right
    // places, no consonant runs — and a perfectly random hex key read as
    // English. Interleaved digits are the signal that it is not.
    const hex = '9f8e7d6c5b4a3210fedcba9876543210'
    expect(entropyRatio(hex)).toBeCloseTo(1, 2)
    expect(looksLikeWords(hex)).toBe(false)
    expect(looksLikeSecret(hex)).toBe(true)
  })
})

describe('placeholders in something that already matched a key format', () => {
  it.each([
    'AKIAAAAAAAAAAAAAAAAA',
    'sk_live_XXXXXXXXXXXXXXXX',
    '00000000-0000-0000-0000-000000000000',
    'aaaaaaaaaaaaaaaaaaaa',
  ])('rejects %s', (value) => {
    expect(looksLikePlaceholder(value)).toBe(true)
  })

  it('keeps a documentation key that reads as language', () => {
    // AWS's own example key. It looks like words and is still worth flagging:
    // anything matching AKIA[0-9A-Z]{16} earns a warning, so this test exists
    // to stop the placeholder check being tightened into rejecting it.
    expect(looksLikePlaceholder('AKIAIOSFODNN7EXAMPLE')).toBe(false)
  })
})

describe('identifiers that only look random', () => {
  it.each([
    'c9a646d3-9c61-4cb7-bf7d-c2ee52d9c631',
    '550e8400-e29b-41d4-a716-446655440000',
    '{6ba7b810-9dad-11d1-80b4-00c04fd430c8}',
  ])('recognises %s as a UUID rather than a credential', (value) => {
    // Entropy cannot tell these apart from a real key — this one scores 0.725
    // and reads as perfectly random — so the structure has to.
    expect(entropyRatio(value)).toBeGreaterThan(0.6)
    expect(looksLikeWords(value)).toBe(false)
    expect(looksLikeStructuredId(value)).toBe(true)
  })

  it.each([
    '9f83b1657ff1fc53b92dc18148a1d65dfc2d4b1f',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ])('does not structurally exclude %s', (value) => {
    // Git SHAs deliberately are not excluded: plenty of real tokens are 40 or
    // 64 hex characters, and `commit = <sha>` already finds nothing because
    // `commit` is not a secret-ish name. The key name does that work. Trading
    // a real credential for a hypothetical commit hash is the wrong way round.
    expect(looksLikeStructuredId(value)).toBe(false)
  })
})

describe('through the engine', () => {
  const secretsIn = (text: string) =>
    scan(text).findings.filter((f) =>
      ['API_KEY', 'ACCESS_TOKEN', 'PASSWORD', 'PRIVATE_KEY'].includes(f.category),
    )

  it.each([
    'api_key = 9f8e7d6c5b4a3210fedcba9876543210',
    'token: xK3mP9qR7wL2nZ8vB5cY',
    'client_secret = "aG9tZS9pYW4vLmNvbmZpZw=="',
    'SESSION_KEY=b7f3c1d9e5a24680b1c3d5e7f9a0b2c4',
    'key AKIAIOSFODNN7EXAMPLE rotated',
    'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
  ])('finds %s', (text) => {
    expect(secretsIn(text).length).toBeGreaterThan(0)
  })

  it.each([
    'api_key = changeme',
    'token: correcthorsebatterystaple',
    'secret = ProductionDatabase',
    'token = see the internal wiki',
    'api_key: TODO before release',
    'access_token = <your token here>',
    'The session_key_suffix column was renamed',
    'AKIAAAAAAAAAAAAAAAAA is a placeholder',
    'sk_live_XXXXXXXXXXXXXXXX in the docs',
    // A correlation id assigned to something called `token`. The engine has a
    // category for these; blocking them as credentials is the most expensive
    // kind of false positive.
    'token = c9a646d3-9c61-4cb7-bf7d-c2ee52d9c631',
    'api_key: 550e8400-e29b-41d4-a716-446655440000',
    'commit = e3b0c44298fc1c149afbf4c8996fb92427ae41e4',
  ])('leaves %s alone', (text) => {
    expect(secretsIn(text)).toHaveLength(0)
  })

  it('still reports a UUID as a UUID', async () => {
    const found = scan('token = c9a646d3-9c61-4cb7-bf7d-c2ee52d9c631').findings
    // Excluded from the secret rule, not dropped from the scan.
    expect(found.map((f) => f.category)).toEqual(['UUID'])
  })
})
