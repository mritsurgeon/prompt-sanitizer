import { category } from '../categories'
import type { Candidate, CategoryId } from '../types'
import { sha256Hex } from './sha256'

/**
 * The allowlist: things this person does not need warning about.
 *
 * A user's own name and email appear in almost everything they write - a
 * signature, a reply-all, their own address in a header. Flagging them on
 * every prompt is the fastest route to somebody switching the extension off,
 * and an extension that is off protects nothing. So this is a precision
 * feature, and precision here is what keeps the tool installed.
 *
 * ## Where it runs, and why not where the plan said
 *
 * At the **candidate** stage, before anything reads the candidates - not as a
 * filter over findings at the end. The plan put it "after overlap resolution,
 * before scoring", which is not a point that exists in this pipeline: scoring
 * happens first, and overlap resolution operates on already-scored candidates.
 *
 * Earlier is also more correct. Candidates feed the document-sensitivity
 * assessment, which counts how many distinct companies a document names, and a
 * user's own employer being named is not evidence that the document is
 * confidential. They also feed entity consistency, the recoverable budget and
 * the declined list. A suppressed identity should be absent from all of that,
 * not filtered out at the end after influencing every part of it.
 *
 * ## Overlap is handled by matching values, not substrings
 *
 * Allowlisting `Acme` must not suppress `jira.acme.internal`. It does not,
 * because a candidate is matched on its own whole value: the `ORGANISATION`
 * candidate `Acme` is removed, and `jira.acme.internal` is a different
 * candidate with a different value. No substring logic is involved, so there
 * is nothing to get wrong.
 *
 * ## What hashing does and does not buy
 *
 * Digests are stored rather than plaintext, as asked. Worth being precise
 * about the threat that addresses: **not** the local device. A user's own name
 * is already in their browser profile, their mail client and their OS account,
 * and a digest in that same browser's storage protects nothing from anybody
 * who can read the storage. What it protects is anything *exported* - a
 * settings file sent to support, a policy pushed to a fleet, an audit report.
 * Those leave the machine, and they should not carry a list of employee names.
 *
 * It follows that the salt is the load-bearing part. An unsalted digest of a
 * name is a lookup in a dictionary of names.
 */

/** A digest is 64 hex characters; anything else is a malformed entry. */
const DIGEST = /^[0-9a-f]{64}$/

export interface AllowlistConfig {
  /**
   * Salted digests of exact values, lowercased and whitespace-collapsed.
   * Produced only by `digestFor`, so both sides normalise identically.
   */
  values: Set<string>
  /**
   * Salted digests of domain suffixes. A hostname matches when any of its own
   * suffixes is present, so `corp.internal` covers `api.corp.internal`.
   */
  domains: Set<string>
  salt: string
}

export const EMPTY_ALLOWLIST: AllowlistConfig = {
  values: new Set(),
  domains: new Set(),
  salt: '',
}

/** The same normalisation on both sides, or nothing ever matches. */
export function normaliseValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function digestFor(value: string, salt: string): string {
  return sha256Hex(`${salt} ${normaliseValue(value)}`)
}

/**
 * Build a config from plaintext, for a caller that holds the values - a
 * settings page taking them from the user - rather than one loading digests
 * computed earlier.
 */
export function buildAllowlist(input: {
  salt: string
  values?: string[]
  domains?: string[]
}): AllowlistConfig {
  return {
    salt: input.salt,
    values: new Set(
      (input.values ?? []).filter(Boolean).map((v) => digestFor(v, input.salt)),
    ),
    domains: new Set(
      (input.domains ?? []).filter(Boolean).map((d) => digestFor(d, input.salt)),
    ),
  }
}

/** Load a config stored as digests, with no plaintext involved. */
export function loadAllowlist(input: {
  salt: string
  valueDigests?: string[]
  domainDigests?: string[]
}): AllowlistConfig {
  const clean = (list: string[] | undefined) =>
    new Set(
      (list ?? []).map((d) => d.trim().toLowerCase()).filter((d) => DIGEST.test(d)),
    )
  return {
    salt: input.salt,
    values: clean(input.valueDigests),
    domains: clean(input.domainDigests),
  }
}

export function isEmpty(allowlist: AllowlistConfig): boolean {
  return allowlist.values.size === 0 && allowlist.domains.size === 0
}

/**
 * Categories an allowlist may suppress.
 *
 * Identity, contact and location only. **Nothing in the `secret` group is
 * suppressible**, whatever somebody puts in their allowlist: a credential is
 * not a matter of personal preference, and an allowlist that could silence one
 * is a footgun pointed at the thing this tool exists to prevent. Enforced
 * here rather than trusted to the caller.
 */
const SUPPRESSIBLE: ReadonlySet<CategoryId> = new Set<CategoryId>([
  'PERSON',
  'EMAIL',
  'ORGANISATION',
  'LOCATION',
  'POSTAL_ADDRESS',
  'PHONE',
  'INTERNAL_HOST',
  'URL',
  'EMPLOYEE_ID',
])

/** Hostnames with more labels than this are not hostnames. */
const MAX_LABELS = 8

/**
 * Every suffix of a hostname, longest first: `api.corp.internal` yields
 * `api.corp.internal`, `corp.internal`, `internal`.
 *
 * This is what makes domain suppression work against digests at all. A suffix
 * test cannot run on a hash - you cannot ask whether a digest ends with
 * something - so the candidate is decomposed and each suffix hashed instead.
 * The plan's version kept domains in plaintext for exactly this reason, which
 * contradicted its own "no plaintext in storage" requirement.
 */
function suffixesOf(host: string): string[] {
  const labels = host.split('.').filter(Boolean)
  if (labels.length === 0 || labels.length > MAX_LABELS) return []
  const out: string[] = []
  for (let i = 0; i < labels.length; i++) out.push(labels.slice(i).join('.'))
  return out
}

/** The hostname part of a candidate, where it has one. */
function hostOf(value: string, id: CategoryId): string | null {
  const lower = normaliseValue(value)
  if (id === 'EMAIL') {
    const at = lower.lastIndexOf('@')
    return at === -1 ? null : lower.slice(at + 1)
  }
  if (id === 'URL') {
    const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#:\s]+)/.exec(lower)
    return match?.[1] ?? null
  }
  if (id === 'INTERNAL_HOST') return lower
  return null
}

/** Would this candidate be suppressed? Synchronous and allocation-light. */
export function isAllowed(
  candidate: Pick<Candidate, 'value' | 'category'>,
  allowlist: AllowlistConfig,
): boolean {
  if (isEmpty(allowlist)) return false
  if (!SUPPRESSIBLE.has(candidate.category)) return false
  // Belt and braces: the category table is the authority on what counts as a
  // secret, and the set above must never drift from it.
  if (category(candidate.category).group === 'secret') return false

  if (
    allowlist.values.size > 0 &&
    allowlist.values.has(digestFor(candidate.value, allowlist.salt))
  ) {
    return true
  }

  if (allowlist.domains.size > 0) {
    const host = hostOf(candidate.value, candidate.category)
    if (host) {
      for (const suffix of suffixesOf(host)) {
        if (allowlist.domains.has(digestFor(suffix, allowlist.salt))) return true
      }
    }
  }

  return false
}

/**
 * Registry, in the same shape as the confirmer and the metrics sink next door:
 * exactly one is active, the default suppresses nothing, and a real one is
 * installed at startup without any engine file changing.
 */
/**
 * Several lists, not one, because each carries its own salt.
 *
 * An organisation pushing an allowlist by policy cannot know the salt a user's
 * own list was built with, and a user cannot be given the organisation's. So a
 * digest can only be checked against the salt it was made with, and the only
 * way to honour both is to evaluate against each in turn. One config with one
 * salt cannot express it.
 */
let active: AllowlistConfig[] = []

export function registerAllowlist(...lists: AllowlistConfig[]): void {
  active = lists.filter((list) => !isEmpty(list))
}

export function getAllowlists(): AllowlistConfig[] {
  return active
}

export function resetAllowlist(): void {
  active = []
}

/**
 * Drop the candidates this person has said they do not need warning about.
 *
 * Returns the same array when there is nothing to do, so an unconfigured
 * allowlist costs one set-size check for the whole scan rather than a digest
 * per candidate.
 */
export function suppressAllowed(
  candidates: Candidate[],
  lists: AllowlistConfig[] = active,
): { kept: Candidate[]; suppressed: number } {
  const usable = lists.filter((list) => !isEmpty(list))
  if (usable.length === 0) return { kept: candidates, suppressed: 0 }

  const kept: Candidate[] = []
  for (const candidate of candidates) {
    if (usable.some((list) => isAllowed(candidate, list))) continue
    kept.push(candidate)
  }
  return { kept, suppressed: candidates.length - kept.length }
}
