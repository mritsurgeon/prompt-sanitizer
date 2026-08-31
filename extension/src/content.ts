import {
  adapterFor,
  isSubmitEvent,
  promptFrom,
  promptNear,
  sendControlFrom,
  type PromptTarget,
} from './adapters'
import { runtime } from './browser'
import { APP_ORIGINS } from './config'
import {
  applyDeeper,
  bannerIsDeep,
  bannerIsOpen,
  dismissBanner,
  showBanner,
  showCleaned,
  showDeeperRunning,
  type BannerAction,
} from './ui'
import type {
  CheckResponse,
  DeepCheckResponse,
  Request,
  SanitizeResponse,
  TakeHandoffResponse,
} from './protocol'

/**
 * The enforcement point.
 *
 * Two moments matter: the paste, and the send. Nothing else is observed — no
 * keystrokes, no mutation observers on the composer, no polling. Typing into
 * an AI site with this installed is byte-for-byte the same as typing without
 * it, which is the only way a protection layer survives daily use.
 *
 * This script holds no detection logic and makes no decisions. It reads the
 * composer, asks the worker, and renders the answer.
 *
 * ## The two stages, from the page's side
 *
 * The rules run first and answer in well under a millisecond. If they find
 * nothing — the ordinary case — this script does nothing at all: no banner, no
 * held keystroke, no visible difference from having no extension installed.
 *
 * Only once something is flagged does the closer look start, and it starts
 * *behind a banner that is already on screen and already actionable*. The user
 * never waits on the model to be able to do something. When it lands, the
 * banner updates in place — usually to withdraw a finding rather than add one.
 */

const adapter = adapterFor(location.hostname)

/**
 * Diagnostics.
 *
 * Adapters are the only part of this system that touches somebody else's DOM,
 * so they are the part that breaks when a site ships a redesign — and they
 * break by finding nothing, which is silent. These lines exist so a broken
 * adapter announces itself instead of quietly degrading to no protection.
 *
 * Categories only, never content: which adapter matched, whether the composer
 * was found. The prompt itself is never logged.
 */
const warned = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[ai-safe] ${message}`)
}

console.info(
  `[ai-safe] active on ${adapter.label} (${adapter.id} adapter). ` +
    `Paste warns, send is checked. Nothing leaves this device.`,
)

/** Text already checked and cleared, so a re-send does not re-prompt. */
let approved = new Set<string>()
/** The exact text the user chose to send anyway. */
let overridden: string | null = null
/** The prompt behind the banner currently on screen. */
let showing: { text: string; target: PromptTarget } | null = null

/** Keep the approved set from growing without bound on a long session. */
function approve(text: string) {
  if (approved.size > 50) approved = new Set()
  approved.add(text)
}

/**
 * How long to hold a send waiting for the worker.
 *
 * The check itself is sub-millisecond; this only covers a worker that has died
 * or never woke. Without it a silent failure would swallow the message
 * outright, which is far worse than an unchecked send the user is told about.
 */
const WORKER_TIMEOUT_MS = 4000

/** The closer look may load a model, so it gets its own, longer budget. */
const DEEP_TIMEOUT_MS = 30_000

function ask<T>(message: Request, timeout = WORKER_TIMEOUT_MS): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: T | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    try {
      // Chrome answers through the callback; Firefox's native `browser.*`
      // ignores the callback entirely and returns a promise. Both are handled
      // here rather than by shipping a polyfill for one function.
      const returned = runtime.runtime.sendMessage(message, (response: T) => {
        // A dead worker sets lastError; treat it as "could not check".
        if (runtime.runtime.lastError) done(null)
        else done(response ?? null)
      }) as unknown as Promise<T> | undefined

      if (typeof returned?.then === 'function') {
        returned.then((response) => done(response ?? null), () => done(null))
      }
    } catch {
      done(null)
    }

    window.setTimeout(() => done(null), timeout)
  })
}

// ---------------------------------------------------------------------------
// Handoff — this tab is the web app, collecting a prompt sent from elsewhere
// ---------------------------------------------------------------------------

/**
 * When the user chooses "Edit in AI Safe", the background worker opens the app
 * and parks the text in session storage. This runs in that new tab, collects
 * it and drops it into the app's own composer.
 *
 * Written through the same adapter used on every other site, so the app needs
 * no special integration and no awareness that an extension exists.
 */
async function collectHandoff(): Promise<void> {
  const response = await ask<TakeHandoffResponse>({ type: 'take-handoff' })
  if (!response?.text) return

  // The app mounts asynchronously, so the composer may not exist yet.
  for (let attempt = 0; attempt < 40; attempt++) {
    const target = promptNear(document.body)
    if (target) {
      target.write(response.text)
      target.element.focus()
      return
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
}

if (APP_ORIGINS.includes(location.origin)) {
  void collectHandoff()
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

document.addEventListener(
  'paste',
  (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text.trim().length < 12) return

    const target = promptFrom(event.target)
    if (!target) {
      // Pasting into a search box or a comment field is not a composer, and
      // must stay silent. Only say something where a prompt was plausibly
      // being written: a large editable that we still could not resolve.
      const into = event.target
      if (into instanceof Element && into.closest('[contenteditable], textarea')) {
        warnOnce(
          'paste-no-composer',
          `a paste landed in an editable on ${adapter.label} that the adapter ` +
            `could not read, so it was NOT checked.`,
        )
      }
      return
    }

    // The paste is never blocked. Blocking it would mean holding the
    // clipboard hostage over a check that is usually clean, and the send is
    // the boundary that actually matters. This warns; submit enforces.
    void review(text, 'paste', target, false)
  },
  true,
)

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function intercept(event: Event): Promise<void> {
  if (!isSubmitEvent(event, adapter)) return

  const target =
    promptFrom(event.target) ??
    (event.target instanceof Element ? promptNear(event.target) : null)

  // The one failure that looks exactly like success.
  //
  // If a redesign moves the composer somewhere the adapter cannot find, this
  // returns and the send proceeds unchecked — indistinguishable, from the
  // outside, from a prompt that was checked and found clean. Silence is how a
  // protection layer rots. So say it, loudly, once per page.
  if (!target) {
    warnOnce(
      'submit-no-composer',
      `saw a send on ${adapter.label} but could not find the composer, so this ` +
        `prompt was NOT checked. The site's layout has probably changed — ` +
        `please report it.`,
    )
    return
  }

  const text = target.read().trim()
  if (text.length < 12) return
  if (approved.has(text) || overridden === text) return

  // How the send was made, so it can be re-issued the same way if it is
  // cleared. Captured before preventDefault, while the event is still live.
  const control = sendControlFrom(event, adapter)

  // Hold the send until the check comes back. This is the one place the
  // extension is allowed to interrupt, and it is why paste can stay lenient.
  // The rules answer in well under a millisecond, so on clean text this is
  // imperceptible and the send goes straight through.
  event.preventDefault()
  event.stopPropagation()

  const response = await review(text, 'submit', target, true, control)
  if (response && response.decision === 'allow') {
    approve(text)
    resend(target, control)
  }
}

document.addEventListener('keydown', (e) => void intercept(e), true)
document.addEventListener('click', (e) => void intercept(e), true)

/**
 * Re-issue the send the user originally made, the way they made it.
 *
 * A click on the send button is replayed as a click on that same button.
 * Nothing else works: a form submits on Enter through implicit submission,
 * which is browser behaviour and not reproducible with `dispatchEvent`, so a
 * synthetic Enter there would quietly eat the message.
 *
 * A keyboard send is replayed as Enter on the composer, which is the
 * documented shortcut in every one of these products.
 */
function resend(target: PromptTarget, control: HTMLElement | null) {
  if (control?.isConnected) {
    control.click()
    return
  }

  target.element.focus()
  const enter = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  })
  target.element.dispatchEvent(enter)
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

async function review(
  text: string,
  reason: 'paste' | 'submit',
  target: PromptTarget,
  holding: boolean,
  control: HTMLElement | null = null,
): Promise<CheckResponse | null> {
  const response = await ask<CheckResponse>({
    type: 'check',
    reason,
    text,
    host: location.hostname,
  })

  // The worker did not answer. Say so rather than implying a clean result:
  // "we found nothing" and "we could not look" are different states.
  if (!response) {
    if (holding) {
      showing = { text, target }
      showBanner({
        response: {
          type: 'checked',
          decision: 'warn',
          headline: 'Could not check this content',
          summary: '',
          findings: [],
          degraded: 'the local checker did not respond',
          ms: 0,
        },
        allowSendAnyway: true,
        onAction: (action) => handle(action, text, target, control),
      })
    }
    return null
  }

  // Nothing found. This is the common case, and it has to be completely
  // invisible — no banner, no delay, no model.
  if (response.decision === 'allow') {
    dismissBanner()
    showing = null
    if (reason === 'submit') approve(text)
    return response
  }

  showing = { text, target }
  showBanner({
    response,
    allowSendAnyway: holding && response.decision !== 'block',
    onAction: (action) => handle(action, text, target, control),
  })

  // Stage two, behind a banner the user can already act on. Nothing waits for
  // this — if they clean or dismiss before it lands, the result is discarded.
  if (response.deeperAvailable) void deepen(text)

  return response
}

/**
 * Ask for the closer look, and fold it into the banner if it is still the one
 * on screen when the answer arrives.
 */
async function deepen(text: string): Promise<void> {
  if (!bannerIsOpen()) return
  showDeeperRunning()

  const result = await ask<DeepCheckResponse>(
    { type: 'deep-check', text, host: location.hostname },
    DEEP_TIMEOUT_MS,
  )

  // The user may have cleaned, dismissed or moved on. Their banner is not ours
  // to overwrite, and a late answer about text nobody is looking at is noise.
  if (!bannerIsOpen() || showing?.text !== text) return

  if (!result) {
    applyDeeper({
      type: 'deep-checked',
      decision: 'warn',
      headline: '',
      summary: '',
      findings: [],
      withdrawn: 0,
      added: 0,
      ms: 0,
      unavailable: 'the closer look did not respond',
    })
    return
  }

  applyDeeper(result)
}

async function handle(
  action: BannerAction,
  text: string,
  target: PromptTarget,
  control: HTMLElement | null,
): Promise<void> {
  if (action === 'dismiss') {
    dismissBanner()
    showing = null
    return
  }

  if (action === 'send-anyway') {
    // Their call, and an informed one — they have seen the findings. Recorded
    // so the same text does not prompt again on the retry.
    overridden = text
    approve(text)
    dismissBanner()
    showing = null
    resend(target, control)
    return
  }

  if (action === 'handoff') {
    // The full app, with all three modes and per-finding control. The prompt
    // travels through the extension's session storage, never the URL.
    await ask({ type: 'handoff', text })
    dismissBanner()
    showing = null
    return
  }

  // redact | pseudonymize
  const cleaned = await ask<SanitizeResponse>(
    {
      type: 'sanitize',
      text,
      host: location.hostname,
      mode: action,
      // Clean what the user was actually shown. If the closer look withdrew a
      // finding, cleaning must not put it back.
      deep: bannerIsDeep(),
    },
    DEEP_TIMEOUT_MS,
  )
  if (!cleaned) return

  target.write(cleaned.text)
  approve(cleaned.text)
  showing = null

  // Never silently. The user must know their words changed.
  showCleaned(cleaned.replaced.length, () => {
    dismissBanner()
  })
}
