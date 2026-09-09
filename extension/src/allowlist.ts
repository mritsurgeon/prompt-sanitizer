import { loadAllowlist, registerAllowlist } from '@/engine/allowlist'
import { runtime } from './browser'
import { UNMANAGED, type Resolved } from './managed'

/**
 * Loading the user's allowlist.
 *
 * Stored as salted digests under one key in `chrome.storage.local`, so the
 * browser profile never holds a list of colleagues' names in plaintext. The
 * salt lives beside them, which is the honest position: this protects an
 * *exported* settings file, not the device itself — anybody who can read the
 * storage can read the salt too.
 *
 * There is no settings UI yet, so today this is populated either by hand or by
 * managed policy. That is deliberate rather than unfinished: the engine seam
 * and the storage shape are what the policy work needs to build against, and
 * a preferences screen that writes the wrong shape is harder to undo than one
 * that does not exist. `chrome.storage.managed` is the same read with a
 * different namespace.
 *
 * Failure is silent by design: an unreadable or absent allowlist means the
 * engine suppresses nothing, which is the safe direction.
 */

export const ALLOWLIST_KEY = 'allowlist'

export interface StoredAllowlist {
  salt: string
  /** 64-character hex digests, from `digestFor`. */
  valueDigests?: string[]
  domainDigests?: string[]
}

/**
 * Install the allowlists — the organisation's, the user's, or both.
 *
 * Two lists rather than one merged set, because each was built with its own
 * salt: an organisation cannot know the salt a user's list used, and a user
 * cannot be handed the organisation's. A digest only means anything against
 * the salt it was made with, so the engine evaluates against each in turn.
 *
 * `AllowUserOverrides: false` drops the user's list entirely. That is the
 * whole point of the setting — an organisation that has decided which
 * identities may be suppressed has not left the rest open.
 */
export async function installAllowlist(managed: Resolved = UNMANAGED): Promise<number> {
  const lists = []
  if (managed.managedAllowlist) lists.push(managed.managedAllowlist)

  if (managed.allowUserOverrides) {
    try {
      const storage = runtime.storage?.local
      const stored = (await storage?.get(ALLOWLIST_KEY)) as
        | { [ALLOWLIST_KEY]?: StoredAllowlist }
        | undefined
      const config = stored?.[ALLOWLIST_KEY]
      if (config?.salt) lists.push(loadAllowlist(config))
    } catch {
      // Suppressing nothing is the safe failure, and it is what the default
      // already does — so there is nothing to report and nothing to repair.
    }
  }

  registerAllowlist(...lists)
  return lists.length
}
