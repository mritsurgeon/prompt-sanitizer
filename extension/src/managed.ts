import { loadAllowlist, type AllowlistConfig } from '@/engine/allowlist'
import { DEFAULT_POLICY, OBSERVE_ONLY, type Decision, type Policy } from '@/engine/policy'
import { runtime } from './browser'

/**
 * Enterprise configuration, read from `chrome.storage.managed`.
 *
 * ## The schema is the engine's own vocabulary
 *
 * The one design rule here, and it is worth stating because the obvious draft
 * breaks it: **do not invent a second vocabulary.** A managed schema with its
 * own words — `ExecutionMode`, `BlockedCategories` — has to be translated into
 * engine types at some point, and that translation is where the two drift. Six
 * months later the schema says `pii` and the engine says `personal`, and
 * nobody can say which one an admin's policy actually did.
 *
 * `policy.ts` already has the vocabulary: four groups (`secret`, `personal`,
 * `confidential`, `internal`), each taking a `Decision` of `allow`, `warn` or
 * `block`, plus a ceiling for uncertain findings and a rule for when the
 * engine cannot be reached. So the schema exposes exactly those, one key per
 * field, and mapping is assignment rather than interpretation.
 *
 * `ExecutionMode` is kept, because an admin who wants audit mode should not
 * have to set six keys to get it — but it selects a *base* policy that the
 * per-group keys then override, rather than being a parallel concept.
 *
 * ## What a wrong value does
 *
 * Nothing. Every field is validated against the engine's own union types and
 * an unrecognised value is dropped rather than coerced. A policy is pushed by
 * somebody who cannot see the result, so a typo must degrade to the default
 * and not to `allow`.
 */

export interface ManagedConfig {
  /** Base policy. Per-group keys below override whatever this selects. */
  ExecutionMode?: 'ENFORCE' | 'OBSERVE_ONLY'
  Secret?: Decision
  Personal?: Decision
  Confidential?: Decision
  Internal?: Decision
  /** Findings the engine is not certain about never escalate beyond this. */
  UncertainCeiling?: Decision
  /** What to do when the engine itself cannot be consulted. */
  OnEngineUnavailable?: Decision
  /** Lowercase hex SHA-256 digests, salted with `AllowlistSalt`. */
  AllowlistDigests?: string[]
  AllowlistDomainDigests?: string[]
  AllowlistSalt?: string
  /** Whether a user's own allowlist is honoured alongside the managed one. */
  AllowUserOverrides?: boolean
}

export interface Resolved {
  policy: Policy
  /** Null when policy pushed no allowlist. */
  managedAllowlist: AllowlistConfig | null
  allowUserOverrides: boolean
  managed: boolean
  /**
   * True when the policy enforces nothing at all. The content script uses this
   * to skip holding a send entirely, so audit mode does not touch the page.
   */
  observeOnly: boolean
}

const DECISIONS: readonly Decision[] = ['allow', 'warn', 'block']

/** Drops anything that is not one of the engine's own decisions. */
function decision(value: unknown): Decision | undefined {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)
    ? (value as Decision)
    : undefined
}

export const UNMANAGED: Resolved = {
  policy: DEFAULT_POLICY,
  managedAllowlist: null,
  allowUserOverrides: true,
  managed: false,
  observeOnly: false,
}

/** True when nothing this policy can decide would interrupt anybody. */
function enforcesNothing(policy: Policy): boolean {
  return (
    policy.secret === 'allow' &&
    policy.personal === 'allow' &&
    policy.confidential === 'allow' &&
    policy.internal === 'allow' &&
    policy.onEngineUnavailable === 'allow'
  )
}

export function resolveManaged(config: ManagedConfig | null): Resolved {
  if (!config || Object.keys(config).length === 0) return UNMANAGED

  // The base, then the overrides. An admin who only wants audit mode sets one
  // key; one who wants to warn on names but block credentials sets two.
  const base = config.ExecutionMode === 'OBSERVE_ONLY' ? OBSERVE_ONLY : DEFAULT_POLICY

  const policy: Policy = {
    secret: decision(config.Secret) ?? base.secret,
    personal: decision(config.Personal) ?? base.personal,
    confidential: decision(config.Confidential) ?? base.confidential,
    internal: decision(config.Internal) ?? base.internal,
    uncertainCeiling: decision(config.UncertainCeiling) ?? base.uncertainCeiling,
    onEngineUnavailable:
      decision(config.OnEngineUnavailable) ?? base.onEngineUnavailable,
  }

  const values = config.AllowlistDigests ?? []
  const domains = config.AllowlistDomainDigests ?? []
  const managedAllowlist =
    values.length + domains.length > 0
      ? loadAllowlist({
          // No default salt: a digest computed with a different salt than the
          // one it is checked against never matches, and silently allowing
          // that would look like an allowlist that simply does not work.
          salt: config.AllowlistSalt ?? '',
          valueDigests: values,
          domainDigests: domains,
        })
      : null

  return {
    policy,
    managedAllowlist,
    allowUserOverrides: config.AllowUserOverrides ?? true,
    managed: true,
    observeOnly: enforcesNothing(policy),
  }
}

/**
 * Read the managed namespace.
 *
 * Absent on a consumer browser, and absent is not an error — it is the
 * overwhelmingly common case. Returns null so the caller falls through to the
 * defaults rather than to anything more permissive.
 */
export async function readManaged(): Promise<ManagedConfig | null> {
  try {
    const area = (runtime.storage as { managed?: chrome.storage.StorageArea })
      ?.managed
    if (!area) return null
    const items = (await area.get(null)) as ManagedConfig
    return items && Object.keys(items).length > 0 ? items : null
  } catch {
    return null
  }
}
