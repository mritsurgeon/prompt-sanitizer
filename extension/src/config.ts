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
