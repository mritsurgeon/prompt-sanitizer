// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { scan } from '@/engine/detect'
import { sanitize } from '@/engine/sanitize'
import type { Replacement } from '@/engine/types'

/**
 * Stand-ins across the worker's lifetime.
 *
 * The property this file exists for: MV3 terminates the service worker after
 * roughly thirty seconds idle, which is the *normal* gap between one turn of a
 * conversation and the next. A vault held in worker memory would forget its
 * mappings between exactly the two turns it exists to connect, and would do so
 * silently — turn two simply calls the same person something different.
 *
 * So every test here reloads from storage between turns, which is what a real
 * eviction does.
 */

// --- chrome.storage.session, stubbed --------------------------------------
let bag: Record<string, unknown> = {}
const removedListeners: Array<(tabId: number) => void> = []

const store = {
  get: async (key: string | null) => {
    if (key === null) return { ...bag }
    return key in bag ? { [key]: bag[key] } : {}
  },
  set: async (items: Record<string, unknown>) => {
    Object.assign(bag, items)
  },
  remove: async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete bag[key]
  },
}

const chromeStub = {
  storage: { session: store, local: store },
  tabs: {
    onRemoved: {
      addListener: (fn: (tabId: number) => void) => removedListeners.push(fn),
    },
  },
  runtime: { lastError: undefined, sendMessage: () => undefined },
}

let hydration: typeof import('../hydration')

beforeAll(async () => {
  vi.stubGlobal('chrome', chromeStub)
  hydration = await import('../hydration')
})

beforeEach(() => {
  bag = {}
  removedListeners.length = 0
})

const SENDER = { tab: { id: 7 }, url: 'https://chatgpt.com/c/abc-123' }

function cleanTurn(text: string, carryFrom: string | null) {
  const findings = scan(text).findings
  return sanitize(text, findings, {
    mode: 'pseudonymize',
    carry: carryFrom
      ? hydration.pseudonymsFrom(
          JSON.parse(JSON.stringify(bag[`vault:${carryFrom}`] ?? null)),
        )
      : undefined,
  })
}

describe('the session key', () => {
  it('is which tab and which conversation', () => {
    expect(hydration.sessionKeyFrom(SENDER)).toBe('7:/c/abc-123')
  })

  it('drops the query string and the fragment', () => {
    // This project never lets a page hand over a URL — the metrics envelope
    // reduces one to its registrable domain, because a full URL is content.
    // A chat id in the path is an opaque handle; `?q=our+acquisition` is not.
    const key = hydration.sessionKeyFrom({
      tab: { id: 7 },
      url: 'https://chatgpt.com/c/abc-123?q=our+acquisition#top',
    })
    expect(key).toBe('7:/c/abc-123')
  })

  it('is null without a tab, because a content script cannot know its own', () => {
    expect(hydration.sessionKeyFrom({ url: 'https://chatgpt.com/c/x' })).toBeNull()
  })
})

describe('surviving worker eviction', () => {
  it('reuses a stand-in in a later turn', async () => {
    const id = hydration.sessionKeyFrom(SENDER)!

    const first = cleanTurn('Ask Sarah Mitchell about the renewal', null)
    await hydration.recordSubstitutions(id, first.replacements)
    const token = first.valueMap.get('Sarah Mitchell')
    expect(token).toBeTruthy()

    // The worker dies here. Everything in its memory is gone; only
    // `storage.session` remains.
    const second = cleanTurn('Sarah Mitchell and David Okafor both approved it', id)
    await hydration.recordSubstitutions(id, second.replacements)

    expect(second.valueMap.get('Sarah Mitchell')).toBe(token)
    // And the newcomer must not be handed a stand-in that is already taken —
    // which is what happens if the counters are not carried across too.
    expect(second.valueMap.get('David Okafor')).not.toBe(token)
  })

  it('does not restart the counter, so a newcomer never collides', async () => {
    const id = 'counters'
    const first = cleanTurn('Ask Sarah Mitchell and David Okafor', null)
    await hydration.recordSubstitutions(id, first.replacements)

    const carried = hydration.pseudonymsFrom(await hydration.loadSession(id))
    // Two people were assigned, so the next one must be the third.
    expect(carried.counters.get('PERSON')).toBe(2)

    const second = cleanTurn('Now add Thandeka Mokoena to the thread', id)
    const fresh = second.valueMap.get('Thandeka Mokoena')
    expect(fresh).toBeDefined()
    expect([...first.valueMap.values()]).not.toContain(fresh)
  })

  it('restores from a reloaded session', async () => {
    const { hydrateWith } = await import('@/engine/hydration/vault')
    const id = 'restore'
    const cleaned = cleanTurn('Email sarah.mitchell@example.com today', null)
    await hydration.recordSubstitutions(id, cleaned.replacements)

    const entries = hydration.entriesOf(await hydration.loadSession(id))
    const token = cleaned.valueMap.get('sarah.mitchell@example.com')
    const { text, restored } = hydrateWith(entries, `I have written to ${token}.`)

    expect(restored).toBe(1)
    expect(text).toContain('sarah.mitchell@example.com')
  })
})

describe('what never enters the store', () => {
  it('excludes credentials by category group', async () => {
    const id = 'secrets'
    const text = 'key AKIAIOSFODNN7EXAMPLE with password = S3cur3!P@ssw0rd#2024x'
    const cleaned = cleanTurn(text, null)
    await hydration.recordSubstitutions(id, cleaned.replacements)

    const stored = JSON.stringify(await hydration.loadSession(id))
    // `PASSWORD`, `ACCESS_TOKEN` and `CONNECTION_STRING` contain neither the
    // word "secret" nor "key", so a guard that looks for those in the category
    // name lets all three through. This checks the outcome, not the guard.
    expect(stored).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(stored).not.toContain('S3cur3!P@ssw0rd#2024x')
  })

  it('marks a many-to-one token ambiguous rather than guessing', async () => {
    const id = 'ambiguous'
    const text = 'Email a.one@example.com and b.two@example.com'
    const findings = scan(text).findings
    // Redact mode: both addresses become the same `[EMAIL]`.
    const cleaned = sanitize(text, findings, { mode: 'redact' })
    await hydration.recordSubstitutions(id, cleaned.replacements)

    const entries = hydration.entriesOf(await hydration.loadSession(id))
    const email = entries.find((e) => e.token === '[EMAIL]')
    expect(email?.ambiguous).toBe(true)

    const { hydrateWith } = await import('@/engine/hydration/vault')
    // Nothing restored is the right answer. Picking one of the two would be
    // worse than leaving it alone.
    expect(hydrateWith(entries, 'Sent to [EMAIL].').restored).toBe(0)
  })

  it('marks it ambiguous across two turns, not only within one', async () => {
    const id = 'across-turns'
    for (const address of ['a.one@example.com', 'b.two@example.com']) {
      const text = `Email ${address}`
      const cleaned = sanitize(text, scan(text).findings, { mode: 'redact' })
      await hydration.recordSubstitutions(id, cleaned.replacements)
    }
    const entries = hydration.entriesOf(await hydration.loadSession(id))
    expect(entries.find((e) => e.token === '[EMAIL]')?.ambiguous).toBe(true)
  })
})

describe('lifetime', () => {
  it('evicts one session', async () => {
    await hydration.recordSubstitutions('gone', [
      { finding: { value: 'Jane Doe', category: 'PERSON' }, replacement: 'Person_001' },
    ] as Replacement[])
    expect(await hydration.loadSession('gone')).not.toBeNull()

    await hydration.evictSession('gone')
    expect(await hydration.loadSession('gone')).toBeNull()
  })

  it('drops a tab’s conversations when the tab closes, and only that tab’s', async () => {
    const mine: Replacement[] = [
      { finding: { value: 'Jane Doe', category: 'PERSON' }, replacement: 'Person_001' },
    ] as Replacement[]
    await hydration.recordSubstitutions('7:/c/one', mine)
    await hydration.recordSubstitutions('7:/c/two', mine)
    await hydration.recordSubstitutions('9:/c/other', mine)

    hydration.watchTabs()
    expect(removedListeners).toHaveLength(1)
    removedListeners[0](7)
    await vi.waitFor(async () =>
      expect(await hydration.loadSession('7:/c/one')).toBeNull(),
    )

    // A conversation the user closed is one they are done with, and these
    // mappings are the only place their real names are held.
    expect(await hydration.loadSession('7:/c/two')).toBeNull()
    expect(await hydration.loadSession('9:/c/other')).not.toBeNull()
  })

  it('does not throw when there is no session storage at all', async () => {
    // Mutating the stub rather than replacing the global: `browser.ts` captures
    // `chrome` once at module load, so a fresh `stubGlobal` would not reach the
    // already-imported `runtime`. The store is looked up per call, so removing
    // it here exercises the real guard.
    const held = chromeStub.storage.session
    ;(chromeStub.storage as { session?: unknown }).session = undefined
    try {
      await expect(
        hydration.recordSubstitutions('x', [
          {
            finding: { value: 'Jane Doe', category: 'PERSON' },
            replacement: 'Person_001',
          },
        ] as Replacement[]),
      ).resolves.toBeUndefined()
      // Losing a mapping costs a manual find-and-replace. It must not cost the
      // sanitization, so nothing here throws upward.
      expect(await hydration.loadSession('x')).toBeNull()
    } finally {
      ;(chromeStub.storage as { session?: unknown }).session = held
    }
  })
})
