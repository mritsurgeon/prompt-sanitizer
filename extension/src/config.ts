/**
 * The few things that have to agree across the worker, the content script and
 * the manifest.
 *
 * Build-time constants rather than settings, because each one has to match a
 * static manifest host permission. Change a value here and change the matching
 * entry in `build.mjs`.
 */

/**
 * Where the full web app lives — the "Edit in AI Safe" destination, with all
 * three sanitization modes, per-finding control and the file tools. It is also
 * where the provisioned model files are served from.
 */
export const APP_ORIGIN = 'http://localhost:5173'

/** Origins the content script will accept a handoff on. */
export const APP_ORIGINS = [APP_ORIGIN, 'http://localhost:4173']

/**
 * Below this, there is nothing the engine could find.
 *
 * It was 12 in two places, chosen as a round number, and 12 hides real
 * findings: the shortest text the engine can flag is a five-character email
 * address (`a@b.c`). Four sits below that rather than at it, so a future rule
 * matching something shorter does not silently start slipping past.
 *
 * Shared, because it was fixed on the composer path and left at 12 on the
 * attachment path — a text file containing only an address went through
 * unchecked while a prompt containing the same address did not.
 */
export const MIN_CHARS = 4
