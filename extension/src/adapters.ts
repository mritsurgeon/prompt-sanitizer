/**
 * Site adapters.
 *
 * These answer four questions and nothing else: where is the prompt, how do I
 * read it, how do I write to it, and was that a send. They contain no
 * detection, no policy and no UI, so a site redesign can break an adapter
 * without touching anything that matters.
 *
 * The generic adapter does almost all of the work, because every one of these
 * products is a `<textarea>` or a `contenteditable` with a send button — the
 * standard DOM has been stable here for years even as the React trees inside
 * have churned. Per-site entries exist only to name a send button more
 * precisely, and each is a couple of selectors. Nothing here reaches into a
 * framework's internals or a generated class name.
 */

export interface PromptTarget {
  element: HTMLElement
  read(): string
  write(text: string): void
}

export interface SiteAdapter {
  id: string
  /** Human name for the popup. */
  label: string
  /** Extra selectors that identify this site's send control. */
  sendSelectors: string[]
}

/** Selectors that mean "send" almost everywhere. */
const GENERIC_SEND = [
  'button[type="submit"]',
  'button[aria-label*="send" i]',
  'button[data-testid*="send" i]',
  'button[title*="send" i]',
]

export const ADAPTERS: SiteAdapter[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    sendSelectors: ['#composer-submit-button', 'button[data-testid="send-button"]'],
  },
  {
    id: 'claude',
    label: 'Claude',
    sendSelectors: ['button[aria-label*="Send message" i]'],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    sendSelectors: ['button.send-button', 'button[aria-label*="Send" i]'],
  },
  {
    id: 'copilot',
    label: 'Copilot',
    sendSelectors: ['button[data-testid="submit-button"]'],
  },
  { id: 'generic', label: 'AI assistant', sendSelectors: [] },
]

const HOST_MATCHERS: { id: string; hosts: RegExp }[] = [
  { id: 'chatgpt', hosts: /(^|\.)(chatgpt\.com|openai\.com)$/ },
  { id: 'claude', hosts: /(^|\.)claude\.ai$/ },
  { id: 'gemini', hosts: /(^|\.)(gemini|bard)\.google\.com$/ },
  { id: 'copilot', hosts: /(^|\.)(copilot\.microsoft\.com|bing\.com|m365\.cloud\.microsoft)$/ },
]

export function adapterFor(host: string): SiteAdapter {
  const match = HOST_MATCHERS.find((m) => m.hosts.test(host))
  const found = ADAPTERS.find((a) => a.id === match?.id)
  // An unknown AI site still gets paste protection through the generic path.
  return found ?? ADAPTERS[ADAPTERS.length - 1]
}

const EDITABLE =
  'textarea, input[type="text"], input[type="search"], [contenteditable="true"], [contenteditable=""]'

/** Walk up from an event target to the editable it happened inside. */
export function promptFrom(target: EventTarget | null): PromptTarget | null {
  let node = target instanceof Node ? target : null
  while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode

  const element = (node as Element | null)?.closest?.(EDITABLE) as
    | HTMLElement
    | null
  if (!element) return null

  const isField =
    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement

  return {
    element,
    read: () => (isField ? element.value : (element.innerText ?? '')),
    write: (text: string) => {
      if (isField) {
        // Set through the native setter so React's onChange still fires;
        // assigning `.value` directly is swallowed by controlled components.
        const proto =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        setter?.call(element, text)
        element.dispatchEvent(new Event('input', { bubbles: true }))
        return
      }

      // contenteditable: replace the text and let the site observe it.
      element.textContent = text
      element.dispatchEvent(new InputEvent('input', { bubbles: true }))
    },
  }
}

/**
 * Was this a send?
 *
 * Enter without a modifier is the universal shortcut in every one of these
 * products; the rest is a button that says so. Deliberately conservative —
 * a missed submit falls back to the paste check, whereas a false submit
 * interrupts somebody mid-sentence.
 */
export function isSubmitEvent(
  event: Event,
  adapter: SiteAdapter,
): boolean {
  if (event instanceof KeyboardEvent) {
    return (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.isComposing
    )
  }

  return sendControlFrom(event, adapter) !== null
}

/**
 * The send button a click landed on, if it was one.
 *
 * Returned rather than merely tested, because a held send has to be re-issued
 * afterwards and the only reliable way to press a button is to press that
 * button. A synthetic Enter cannot stand in for it: implicit form submission
 * is a browser behaviour, not something `dispatchEvent` reproduces.
 */
export function sendControlFrom(
  event: Event,
  adapter: SiteAdapter,
): HTMLElement | null {
  const node = event.target instanceof Node ? event.target : null
  const element =
    node?.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : (node?.parentElement ?? null)
  if (!element?.closest) return null

  for (const selector of [...adapter.sendSelectors, ...GENERIC_SEND]) {
    try {
      const found = element.closest(selector)
      if (found) return found as HTMLElement
    } catch {
      // A malformed selector is a broken adapter, not a broken page.
    }
  }
  return null
}

/** The composer nearest a send button, when the click did not start inside it. */
export function promptNear(element: Element): PromptTarget | null {
  const form = element.closest('form') ?? element.parentElement?.parentElement
  const editable = form?.querySelector(EDITABLE) as HTMLElement | null
  if (editable) return promptFrom(editable)

  // Last resort: the biggest visible editable on the page.
  const all = [...document.querySelectorAll(EDITABLE)] as HTMLElement[]
  const visible = all.filter((el) => el.offsetParent !== null)
  const largest = visible.sort(
    (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
  )[0]
  return largest ? promptFrom(largest) : null
}
