/**
 * Getting to an event before the page does.
 *
 * Two facts decide whether interception works, and neither is about worlds.
 *
 * **Order is registration order, per node and per phase.** An isolated-world
 * content script competes with the page's own listeners on equal terms — DOM
 * dispatch does not know or care which world a listener came from, which is
 * why `stopPropagation` from a content script does stop a page listener. What
 * it cannot do is undo a listener that already ran. So the script has to be
 * registered before the app registers its own, which is what
 * `run_at: document_start` is for.
 *
 * **Capture descends from `window`.** The path is `window` -> `document` ->
 * ancestors -> target, and only then back up. A page listening on `window` at
 * capture phase beats a content script listening on `document` at capture
 * phase however early that script ran. So we register on `window` as well, and
 * are then first in the path rather than merely early in it.
 *
 * Registering twice means the same event arrives twice, so handlers are
 * deduplicated on the event object itself. Not on a property of the event —
 * the page shares the DOM and can read and write those — but in a `WeakSet`
 * held here, which nothing outside this module can reach.
 */

const seen = new WeakSet<Event>()

/**
 * Register a handler at the very front of the capture path.
 *
 * The handler sees each event once, whichever of the two registrations
 * delivers it first.
 */
export function listenFirst(
  type: string,
  handler: (event: Event) => void,
): () => void {
  const once = (event: Event) => {
    if (seen.has(event)) return
    seen.add(event)
    handler(event)
  }

  // `window` first so it is the earlier registration on the earlier node.
  window.addEventListener(type, once, true)
  document.addEventListener(type, once, true)

  return () => {
    window.removeEventListener(type, once, true)
    document.removeEventListener(type, once, true)
  }
}

/**
 * Mark an event as already handled without handling it.
 *
 * For an event this extension dispatched itself: the replay has to reach the
 * page, and must not come back around to us.
 */
export function markHandled(event: Event): void {
  seen.add(event)
}
