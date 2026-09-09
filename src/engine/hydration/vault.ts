import { category } from '../categories'
import type { CategoryId, Pseudonyms, Replacement } from '../types'
import { emptyPseudonyms } from '../sanitize'

/**
 * The hydration vault: putting the real values back.
 *
 * Cleaning a prompt solves half a problem and creates the other half. Mask the
 * names, ask the model to draft a disciplinary email, and it hands back a
 * letter addressed to `Person_001` about `Person_002`'s missed deadlines. The
 * user now has to repair it by hand, which is worse than the problem they
 * started with, and they learn not to clean anything.
 *
 * So the substitutions are remembered for the length of a conversation and the
 * model's answer can be put back into the user's own words, locally.
 *
 * ## Only nickname mode is reversible, which is the opposite of what it looks
 *
 * The obvious assumption is that placeholders — `[EMAIL]`, `[PERSON_NAME]` —
 * are the safe mode to invert because they are syntactically unmistakable.
 * They are the one mode that **cannot** be inverted. Every email in a document
 * becomes the same `[EMAIL]`, so the mapping is many-to-one and there is no
 * way back:
 *
 *     redact        "Email [EMAIL] and [EMAIL]"          <- ambiguous
 *     pseudonymize  "Email Email_001 and Email_002"      <- invertible
 *     synthetic     "Email riley.nolan@example.com ..."  <- invertible, risky
 *
 * Nickname mode is the reversible one because its stand-ins are unique.
 * Synthetic mode is unique too but looks like ordinary language, so a model
 * that happens to write `riley.nolan@example.com` itself would have it
 * "restored" into somebody's real address. The vault records both and refuses
 * to invert an ambiguous token, so redact mode degrades to "nothing to
 * restore" rather than to a wrong answer.
 *
 * ## Secrets never enter
 *
 * A credential is removed, not substituted, and it must not come back — the
 * point of stripping a key is that it stops existing in the conversation.
 * Enforced against the category table, because a name test is not enough:
 * `PASSWORD`, `ACCESS_TOKEN` and `CONNECTION_STRING` contain neither the word
 * "secret" nor "key", and a guard that looks for those in the category name
 * lets all three through.
 */

export interface VaultEntry {
  original: string
  token: string
  category: CategoryId
  /** True when more than one distinct value was given this token. */
  ambiguous: boolean
}

export interface Session {
  id: string
  /** Stand-in assignments, handed back to `sanitize` on the next turn. */
  pseudonyms: Pseudonyms
  /** token -> what it stands for. */
  entries: Map<string, VaultEntry>
  updatedAt: number
}

/**
 * Bracketed placeholders are self-delimiting; nickname and synthetic
 * stand-ins are not.
 *
 * This distinction is why one regex with `\b` on both ends does not work.
 * `\b` asserts a word/non-word transition, so before the `[` of `[EMAIL]`
 * — preceded by a space — there is no transition and no match. A single
 * pattern of that shape hydrates *nothing* in placeholder mode, silently.
 */
const SELF_DELIMITED = /^[[({<].*[\])}>]$/

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface HydrationOutcome {
  text: string
  restored: number
}

/** Entries worth offering: unique stand-ins only. */
export function restorableFrom(entries: VaultEntry[]): VaultEntry[] {
  return entries.filter((entry) => !entry.ambiguous)
}

/**
 * Put the real values back, given the entries.
 *
 * Pure and free of the vault, because the popup loads a serialised session out
 * of `storage.session` and never holds a vault instance.
 *
 * Longest token first, and the order is load-bearing: with `Person_1` ahead of
 * `Person_10` in the alternation, `Person_10` is left untouched entirely — the
 * engine matches `Person_1`, the trailing boundary fails against the `0`, and
 * it abandons the position rather than trying the longer branch.
 */
export function hydrateWith(entries: VaultEntry[], text: string): HydrationOutcome {
  const usable = restorableFrom(entries)
  if (usable.length === 0) return { text, restored: 0 }

  const byToken = new Map(usable.map((entry) => [entry.token, entry]))
  const tokens = usable
    .map((entry) => entry.token)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))

  // Two groups, because the boundary rules differ. Self-delimiting tokens need
  // no assertion; bare ones need one on each side, or `Person_001` would match
  // inside `Person_0012`.
  const bare = tokens.filter((t) => !SELF_DELIMITED.test(t)).map(escape)
  const bracketed = tokens.filter((t) => SELF_DELIMITED.test(t)).map(escape)

  const parts: string[] = []
  if (bare.length) parts.push(`\\b(?:${bare.join('|')})\\b`)
  if (bracketed.length) parts.push(`(?:${bracketed.join('|')})`)
  if (!parts.length) return { text, restored: 0 }

  let restored = 0
  const out = text.replace(new RegExp(parts.join('|'), 'g'), (match) => {
    const entry = byToken.get(match)
    if (!entry) return match
    restored += 1
    return entry.original
  })

  return { text: out, restored }
}

export class HydrationVault {
  private sessions = new Map<string, Session>()
  /** How many sessions to keep before evicting the least recently used. */
  private readonly maxSessions: number

  constructor(maxSessions = 32) {
    // Declared rather than a constructor parameter property, which
    // `erasableSyntaxOnly` forbids.
    this.maxSessions = maxSessions
  }

  session(id: string): Session {
    const existing = this.sessions.get(id)
    if (existing) return existing

    // Bounded: a long-lived worker that never sees a tab close must not grow
    // without limit.
    if (this.sessions.size >= this.maxSessions) {
      let oldest: Session | null = null
      for (const candidate of this.sessions.values()) {
        if (!oldest || candidate.updatedAt < oldest.updatedAt) oldest = candidate
      }
      if (oldest) this.sessions.delete(oldest.id)
    }

    const fresh: Session = {
      id,
      pseudonyms: emptyPseudonyms(),
      entries: new Map(),
      updatedAt: Date.now(),
    }
    this.sessions.set(id, fresh)
    return fresh
  }

  /** Stand-ins to hand back to `sanitize` so this turn matches the last one. */
  carryFor(id: string): Pseudonyms {
    return this.session(id).pseudonyms
  }

  /**
   * Record what a sanitization actually replaced.
   *
   * Driven from `sanitize`'s own manifest rather than from the findings, so a
   * value the allowlist suppressed — never replaced, and therefore never in
   * need of restoring — cannot end up with a vault entry.
   */
  record(id: string, result: { replacements: Replacement[]; pseudonyms: Pseudonyms }): void {
    const session = this.session(id)
    session.pseudonyms = result.pseudonyms
    session.updatedAt = Date.now()

    for (const { finding, replacement } of result.replacements) {
      // A credential is removed rather than substituted, and putting one back
      // would undo the only thing that mattered about removing it.
      if (category(finding.category).group === 'secret') continue

      const existing = session.entries.get(replacement)
      if (!existing) {
        session.entries.set(replacement, {
          original: finding.value,
          token: replacement,
          category: finding.category,
          ambiguous: false,
        })
        continue
      }

      // Two different values wearing one stand-in. That is redact mode by
      // design, and there is no correct way back — so the token is marked and
      // left alone rather than guessed at.
      if (existing.original !== finding.value) existing.ambiguous = true
    }
  }

  /** What could be restored in this session, for a UI to report. */
  restorable(id: string): VaultEntry[] {
    return restorableFrom([...(this.sessions.get(id)?.entries.values() ?? [])])
  }

  /** Every entry, ambiguous ones included, for serialisation. */
  entriesFor(id: string): VaultEntry[] {
    return [...(this.sessions.get(id)?.entries.values() ?? [])]
  }

  /**
   * Put the real values back into a model's answer.
   *
   * Delegates to `hydrateWith`, which is where the matching rules live. The
   * popup reads a serialised session straight out of `storage.session` and has
   * no vault to ask, so the logic has to be callable without one.
   */
  hydrate(id: string, text: string): HydrationOutcome {
    const session = this.sessions.get(id)
    if (!session) return { text, restored: 0 }
    return hydrateWith([...session.entries.values()], text)
  }

  evict(id: string): void {
    this.sessions.delete(id)
  }

  clear(): void {
    this.sessions.clear()
  }

  get size(): number {
    return this.sessions.size
  }
}
