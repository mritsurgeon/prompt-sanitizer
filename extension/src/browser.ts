/**
 * The entire browser-specific surface.
 *
 * Chrome exposes `chrome.*` and Firefox exposes a promise-based `browser.*`;
 * Chrome's MV3 APIs also return promises now, so one alias covers both and
 * this file stays the only place that knows the difference. Edge and Opera are
 * Chromium and need nothing extra.
 */

declare const browser: typeof chrome | undefined

export const runtime: typeof chrome = (() => {
  if (typeof browser !== 'undefined') return browser
  return chrome
})()

/** Firefox needs a real page for the popup; Chromium is happy either way. */
export const isFirefox =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox')
