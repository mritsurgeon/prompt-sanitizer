import { emptyPseudonyms } from '@/engine/sanitize'
import type { VaultEntry } from '@/engine/hydration/vault'
import type { CategoryId, Pseudonyms, Replacement } from '@/engine/types'
import { category } from '@/engine/categories'
import { runtime } from './browser'

/**
 * Where the stand-ins live between turns.
 *
 * `chrome.storage.session`, and the choice is forced rather than preferred: an
 * in-memory map in the service worker does not survive. MV3 terminates the
 * worker after roughly thirty seconds idle, which is the *normal* gap between
 * one turn of a conversation and the next — so a vault held in worker memory
 * would forget its mappings between exactly the two turns it exists to
 * connect, and it would do so silently.
 *
 * `storage.session` is RAM-only, never written to disk, and cleared when the
 * browser closes. That satisfies the lifetime rule this feature needs while
 * surviving worker eviction. It is also already what "Edit in AI Safe" uses to
 * hand a prompt to the app.
 *
 * Being precise about what is stored: **original values in plaintext**, in
 * memory, for the life of the browser session. That is unavoidable — restoring
 * a name requires knowing the name — and it is why eviction on tab close
 * matters, and why nothing here is ever persisted.
 */

const PREFIX = 'vault:'

export interface StoredSession {
  id: string
  updatedAt: number
  /** Array rather than Map, because storage serialises through JSON. */
  entries: Array<{
    original: string
    token: string
    category: CategoryId
    ambiguous: boolean
  }>
}

const keyFor = (id: string) => `${PREFIX}${id}`

/**
 * The session key: which tab, and which conversation inside it.
 *
 * Derived in the worker from `sender`, never sent by the page. Two reasons: a
 * content script cannot know its own tab id, and this project deliberately
 * never lets a page hand over a URL — the metrics envelope reduces one to its
 * registrable domain because a full URL is content.
 *
 * The pathname is kept because a chat id lives there and is what makes turn
 * two the same conversation as turn one. The query string and fragment are
 * dropped: those are where content ends up.
 */
export function sessionKeyFrom(sender: {
  tab?: { id?: number }
  url?: string
}): string | null {
  const tabId = sender.tab?.id
  if (typeof tabId !== 'number') return null
  let path = ''
  try {
    path = sender.url ? new URL(sender.url).pathname : ''
  } catch {
    path = ''
  }
  return `${tabId}:${path}`
}

async function sessionStore(): Promise<chrome.storage.StorageArea | null> {
  const area = (runtime.storage as { session?: chrome.storage.StorageArea })?.session
  return area ?? null
}

export async function loadSession(id: string): Promise<StoredSession | null> {
  try {
    const store = await sessionStore()
    if (!store) return null
    const key = keyFor(id)
    const bag = (await store.get(key)) as Record<string, StoredSession | undefined>
    return bag?.[key] ?? null
  } catch {
    return null
  }
}

/**
 * Fold this turn's substitutions into the session.
 *
 * Driven from `sanitize`'s own manifest rather than from the findings, so a
 * value the allowlist suppressed — never replaced, so never in need of
 * restoring — cannot acquire an entry.
 */
export async function recordSubstitutions(
  id: string,
  replacements: Replacement[],
): Promise<void> {
  try {
    const store = await sessionStore()
    if (!store) return

    const existing = await loadSession(id)
    const entries = new Map<string, StoredSession['entries'][number]>(
      (existing?.entries ?? []).map((entry) => [entry.token, entry]),
    )

    for (const { finding, replacement } of replacements) {
      // A credential is removed, not substituted, and putting one back would
      // undo the only thing that mattered about removing it. Checked against
      // the category table because `PASSWORD`, `ACCESS_TOKEN` and
      // `CONNECTION_STRING` contain neither the word "secret" nor "key".
      if (category(finding.category).group === 'secret') continue

      const held = entries.get(replacement)
      if (!held) {
        entries.set(replacement, {
          original: finding.value,
          token: replacement,
          category: finding.category,
          ambiguous: false,
        })
        continue
      }
      // Two distinct values wearing one stand-in — redact mode by design.
      // There is no correct way back, so the token is marked and left alone.
      if (held.original !== finding.value) held.ambiguous = true
    }

    const session: StoredSession = {
      id,
      updatedAt: Date.now(),
      entries: [...entries.values()],
    }
    await store.set({ [keyFor(id)]: session })
  } catch {
    // Losing a mapping costs the user a manual find-and-replace. It must not
    // cost them the sanitization itself, so this never throws upward.
  }
}

/**
 * The stand-ins already assigned in this conversation, for `sanitize` to reuse.
 *
 * Reconstructed from the entries rather than stored separately. The assignment
 * map is `category::value -> token` and the entries are `token -> value +
 * category`, so one is derivable from the other — and storing both would mean
 * keeping two representations of the same fact in sync across a serialisation
 * boundary.
 *
 * The counters are derived from the tokens' own numeric suffixes, so a
 * newcomer in turn two is never handed a stand-in that already belongs to
 * somebody.
 */
export function pseudonymsFrom(session: StoredSession | null): Pseudonyms {
  const carried = emptyPseudonyms()
  if (!session) return carried

  for (const entry of session.entries) {
    if (entry.ambiguous) continue
    const key = `${entry.category}::${entry.original.toLowerCase().replace(/\s+/g, ' ')}`
    carried.assigned.set(key, entry.token)
    carried.used.add(entry.token)

    const suffix = /_(\d+)$/.exec(entry.token)
    if (suffix) {
      const seen = Number(suffix[1])
      const highest = carried.counters.get(entry.category) ?? 0
      if (seen > highest) carried.counters.set(entry.category, seen)
    }
  }
  return carried
}

export async function evictSession(id: string): Promise<void> {
  try {
    const store = await sessionStore()
    await store?.remove(keyFor(id))
  } catch {
    // Nothing to do: the alternative to removing it is leaving it, and it is
    // in memory that the browser will reclaim anyway.
  }
}

/**
 * Drop a tab's vaults when the tab closes.
 *
 * A conversation the user has closed is one they are done with, and the
 * mappings are the only place their real names are held. Keyed by prefix
 * because one tab can hold several conversations over its life.
 */
export function watchTabs(): void {
  try {
    runtime.tabs?.onRemoved.addListener((tabId) => {
      void (async () => {
        const store = await sessionStore()
        if (!store) return
        const all = (await store.get(null)) as Record<string, unknown>
        const stale = Object.keys(all).filter((key) =>
          key.startsWith(`${PREFIX}${tabId}:`),
        )
        if (stale.length) await store.remove(stale)
      })()
    })
  } catch {
    // Without the hook the mappings still go when the browser closes, which
    // is the outer bound this feature promises.
  }
}

/** Entries in the shape the engine's pure hydrator wants. */
export function entriesOf(session: StoredSession | null): VaultEntry[] {
  return (session?.entries ?? []).map((entry) => ({
    original: entry.original,
    token: entry.token,
    category: entry.category,
    ambiguous: entry.ambiguous,
  }))
}
