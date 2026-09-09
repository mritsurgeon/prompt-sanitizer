/**
 * How random does a string look?
 *
 * Layer 1 catches secrets with a shape — `AKIA…`, `ghp_…`, `sk-…`, a JWT. It
 * cannot catch the ones without: a 32-character hex database password, an
 * internal salt, a token from a service nobody wrote a rule for. Those are
 * recognisable only by looking random, in a place where a secret belongs.
 *
 * ## Why an absolute bits-per-character floor does not work
 *
 * The obvious design is "flag it if Shannon entropy exceeds 4.5 bits per
 * character". That threshold is unreachable, and the reason is arithmetic:
 * a string of length n contains at most n distinct symbols, so its per-symbol
 * entropy cannot exceed **log2(n)**. A 16-character string caps at 4.0 bits
 * and a 20-character one at 4.32, so a 4.5 floor rejects every candidate
 * shorter than 23 characters — including everything that passes a
 * `length >= 16` gate. The rule looks strict and is in fact inert.
 *
 * So the measure here is normalised: entropy over the maximum entropy a string
 * of that length drawn from that alphabet could have. The result is 0..1 and
 * means the same thing at every length, which is what a threshold needs.
 */

/** Shannon entropy in bits per symbol. */
export function shannonEntropy(value: string): number {
  if (!value) return 0
  const counts = new Map<string, number>()
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1)
  }
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * The alphabet the value looks drawn from, inferred from what it contains.
 *
 * Used as the entropy ceiling, so it has to be the plausible source alphabet
 * rather than the observed one — a hex string of `deadbeef` should be measured
 * against hex, not against the eight characters it happens to use.
 */
export function alphabetSize(value: string): number {
  if (/^[0-9]+$/.test(value)) return 10
  if (/^[0-9a-f]+$/i.test(value)) return 16
  if (/^[A-Z2-7]+=*$/.test(value)) return 32 // base32
  if (/^[0-9a-zA-Z+/]+=*$/.test(value)) return 64 // base64
  if (/^[0-9a-zA-Z_-]+$/.test(value)) return 64 // base64url
  if (/^[0-9a-zA-Z]+$/.test(value)) return 62
  // Mixed punctuation — a printable-ASCII password.
  return 94
}

/**
 * Entropy as a fraction of the most this string could have had. 0..1.
 *
 * Comparable across lengths, which an absolute bits-per-character figure is
 * not. `deadbeefdeadbeef` scores low because it repeats; a random hex string
 * of the same length scores high.
 */
export function entropyRatio(value: string): number {
  if (value.length < 2) return 0
  const ceiling = Math.log2(Math.min(value.length, alphabetSize(value)))
  if (ceiling <= 0) return 0
  return Math.min(1, shannonEntropy(value) / ceiling)
}

/**
 * Words are not secrets, whatever their entropy.
 *
 * `Hunter2Hunter2` and `correcthorsebattery` score respectably on entropy
 * because English is not that predictable at the character level. What
 * separates a token from a passphrase is not randomness but the absence of
 * pronounceable structure — so a candidate that reads as words is rejected
 * regardless of its ratio, and the assignment rules that name a password
 * catch those instead.
 */
export function looksLikeWords(value: string): boolean {
  // Language is made of letters. Judging vowel structure after stripping
  // digits and symbols was the first version's bug: `9f8e7d6c5b4a3210` reduces
  // to `fedcba…`, which has vowels in all the right places and no consonant
  // runs, so a perfectly random hex key read as English and was rejected.
  // Interleaved digits are the signal that it is not.
  const letters = value.replace(/[^A-Za-z]/g, '')
  if (letters.length < 6) return false
  if (letters.length / value.length < 0.75) return false

  // A token drawn from a random alphabet has vowels at chance rate; English
  // runs 35-40%. Well below chance means "not language".
  const vowelShare = (letters.match(/[aeiouAEIOU]/g) ?? []).length / letters.length
  if (vowelShare < 0.2) return false

  // And it has to be pronounceable: no run of five consonants.
  return !/[^aeiouAEIOU]{5,}/.test(letters)
}

/**
 * Identifiers with a structure of their own.
 *
 * A UUID assigned to something called `token` is not a credential — it is a
 * correlation id, and the engine already has a category for it. Without this
 * exclusion the assignment rule outranks that category and reports
 * `token = c9a646d3-9c61-4cb7-bf7d-c2ee52d9c631` as an API key, at ratio
 * 0.725 and reading as perfectly random. That is a false positive in a
 * category the policy layer may block, which is the most expensive kind.
 *
 * Only shapes with a *defined* structure belong here. Git SHAs deliberately
 * do not: plenty of real tokens are 40 hex characters, and `commit = <sha>`
 * already finds nothing because `commit` is not a secret-ish name — the key
 * name does that work, not a shape rule. Excluding all 40-hex strings would
 * trade a real credential for a hypothetical commit hash.
 */
const UUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i

export function looksLikeStructuredId(value: string): boolean {
  return UUID.test(value.trim())
}

/**
 * Obvious filler in something that already matched a known key format.
 *
 * A separate, far more permissive test than `looksLikeSecret`, and it has to
 * be: `AKIAIOSFODNN7EXAMPLE` is AWS's own documentation key and reads as
 * language, but anything matching `AKIA[0-9A-Z]{16}` is worth flagging
 * regardless. The only thing worth rejecting here is a placeholder — a run of
 * X's, a row of zeroes, the same character repeated — because those appear in
 * committed config templates and flagging them trains people to ignore the
 * warning.
 */
export function looksLikePlaceholder(value: string): boolean {
  return entropyRatio(value) < 0.45
}

/**
 * Does this look like an opaque credential?
 *
 * Deliberately conservative. This gates a category the policy layer is allowed
 * to **block**, so a false positive here does not annoy somebody — it stops
 * them working.
 */
export interface SecretShape {
  minLength: number
  minRatio: number
}

export const DEFAULT_SECRET_SHAPE: SecretShape = {
  // Shorter than this and there is not enough signal to tell a token from an
  // abbreviation, whatever the ratio says.
  minLength: 16,
  minRatio: 0.85,
}

export function looksLikeSecret(
  value: string,
  shape: SecretShape = DEFAULT_SECRET_SHAPE,
): boolean {
  if (value.length < shape.minLength) return false
  if (looksLikeWords(value)) return false
  // At least two character classes, or a long single-class run. A single short
  // class is a word, an identifier or a number.
  const classes =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/[0-9]/.test(value)) +
    Number(/[^0-9A-Za-z]/.test(value))
  if (classes < 2 && value.length < 24) return false
  return entropyRatio(value) >= shape.minRatio
}
