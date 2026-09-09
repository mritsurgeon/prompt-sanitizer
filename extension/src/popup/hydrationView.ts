import { hydrateWith, restorableFrom } from '@/engine/hydration/vault'
import { runtime } from '../browser'
import { entriesOf, loadSession } from '../hydration'

/**
 * The hydration panel.
 *
 * Cleaning a prompt solves half a problem and creates the other half: mask the
 * names, ask for a draft, and the model answers about `Person_001`. This is
 * where the user gets their own words back.
 *
 * ## Why it lives in the popup
 *
 * Two other surfaces were considered and both were declined.
 *
 * Intercepting the native copy button would mean listening for `copy` on the
 * assistant's output — which turns the extension into a reader of model
 * responses. It observes three user-initiated moments and nothing else, and
 * that claim is worth more than the convenience.
 *
 * Injecting a button into the response would mean mutating a React tree we do
 * not own, on a page whose markup changes without notice. Every adapter in
 * this project deliberately avoids framework internals; this would have been
 * the first thing that did not.
 *
 * So: the user opens the popup and pastes. Explicit, user-driven, and it
 * cannot break when a site ships a redesign.
 *
 * The panel is hidden entirely when there is nothing to restore, for the same
 * reason the banner is: silence is the normal case, and a surface that is
 * always there but usually empty is noise.
 */

/** Built with DOM calls rather than `innerHTML`, so a restored name — which
 *  is user data and may contain anything — can never be parsed as markup. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

async function activeSessionKey(): Promise<string | null> {
  try {
    const [tab] = await runtime.tabs.query({ active: true, currentWindow: true })
    if (typeof tab?.id !== 'number') return null
    // Derived the same way the worker derives it, from the same two parts:
    // which tab, and which conversation inside it.
    let path = ''
    try {
      path = tab.url ? new URL(tab.url).pathname : ''
    } catch {
      path = ''
    }
    return `${tab.id}:${path}`
  } catch {
    return null
  }
}

export async function renderHydration(container: HTMLElement): Promise<void> {
  const key = await activeSessionKey()
  if (!key) return

  const session = await loadSession(key)
  const entries = entriesOf(session)
  const restorable = restorableFrom(entries)

  // Nothing was masked in this conversation, or everything masked was masked
  // with placeholders, which are many-to-one and cannot be put back.
  if (restorable.length === 0) return

  const head = element('div', 'hy-head')
  head.append(
    element('span', 'hy-title', 'Restore original names'),
    element(
      'span',
      'hy-count',
      `${restorable.length} stand-in${restorable.length === 1 ? '' : 's'}`,
    ),
  )

  const hint = element(
    'p',
    'hy-hint',
    'Paste the assistant’s reply to put your own names back. It never leaves this device.',
  )

  const input = element('textarea', 'hy-field')
  input.placeholder = 'Paste the reply here…'

  const button = element('button', 'hy-button', 'Restore')
  const status = element('p', 'hy-status')
  status.hidden = true

  const output = element('textarea', 'hy-field')
  output.readOnly = true
  output.hidden = true

  button.addEventListener('click', () => {
    const raw = input.value
    if (!raw.trim()) return

    const { text, restored } = hydrateWith(entries, raw)
    output.value = text
    output.hidden = false
    status.hidden = false

    if (restored === 0) {
      status.className = 'hy-status none'
      status.textContent = 'No stand-ins found in that text.'
      return
    }

    status.className = 'hy-status'
    status.textContent = `Restored ${restored} value${restored === 1 ? '' : 's'}.`
    // Selected rather than written to the clipboard: writing would need a
    // permission this extension deliberately does not hold, and the user has
    // to be the one who copies their own data.
    output.focus()
    output.select()
  })

  container.append(head, hint, input, button, status, output)
  container.hidden = false
}
