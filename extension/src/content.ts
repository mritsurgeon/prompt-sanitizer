import {
  adapterFor,
  isSubmitEvent,
  promptFrom,
  promptNear,
  sendControlFrom,
  type PromptTarget,
} from './adapters'
import { runtime } from './browser'
import { APP_ORIGINS, MIN_CHARS } from './config'
import { installFileInterceptors, type FileGuardDeps } from './files'
import { listenFirst } from './listen'
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
  AttachmentResponse,
  CheckResponse,
  ConfigResponse,
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

/**
 * Clearance, scoped to the composer it was granted in and compared on
 * normalised text.
 *
 * Both halves fix real bugs. Keying on the element stops a clearance granted
 * in one editable from silencing a different one on the same page.
 *
 * Normalising matters more. Cleaning writes the sanitizer's string with
 * `target.write()`, but the next send reads the composer back with
 * `target.read()` — and for a `contenteditable` those are not the same
 * function. `write` sets `textContent`; the site's editor then re-wraps the
 * content into its own nodes, and `read` returns `innerText`, which inserts
 * and collapses whitespace around them. Comparing raw strings therefore
 * misses, and the user gets warned a second time about text this tool wrote
 * itself — which reads as the cleaning not having worked.
 */
const cleared = new WeakMap<HTMLElement, Set<string>>()

/** Editors move whitespace around; nothing else about the text may differ. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The exact text the user chose to send anyway. */
let overridden: string | null = null
/** The prompt behind the banner currently on screen. */
let showing: { text: string; target: PromptTarget } | null = null

function approve(element: HTMLElement, text: string) {
  const set = cleared.get(element) ?? new Set<string>()
  // Bounded, so a long session cannot grow this without limit.
  if (set.size > 50) set.clear()
  set.add(normalise(text))
  cleared.set(element, set)
}

function isApproved(element: HTMLElement, text: string): boolean {
  const key = normalise(text)
  return cleared.get(element)?.has(key) === true || overridden === key
}

/**
 * How this browser is configured, fetched once at load.
 *
 * Only one field changes what happens on the page: in observe-only mode the
 * send is not held at all. That is the difference between an audit deployment
 * and an enforcing one, and it has to be known *before* the send rather than
 * after — holding a keystroke and then releasing it is still holding it, and
 * an organisation running in audit mode has asked for the page not to be
 * touched.
 *
 * Until it arrives the enforcing path applies, which is the conservative
 * direction: a load race must not silently disable protection.
 */
let observeOnly = false
let managedByPolicy = false

/** Test-only: forget every clearance and any banner state between cases. */
export function resetForTests(): void {
  overridden = null
  showing = null
  observeOnly = false
  managedByPolicy = false
  warned.clear()
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

  // The app mounts asynchronously, so the composer may not exist yet — and at
  // `document_start` neither does `document.body`.
  for (let attempt = 0; attempt < 40; attempt++) {
    const target = document.body ? promptNear(document.body) : null
    if (target) {
      target.write(response.text)
      target.element.focus()
      return
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

export function onPaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (text.trim().length < MIN_CHARS) return

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

  // The paste is never blocked. Blocking it would mean holding the clipboard
  // hostage over a check that is usually clean, and the send is the boundary
  // that actually matters. This warns; submit enforces.
  void review(text, 'paste', target, false)
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export async function intercept(event: Event): Promise<void> {
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
  if (text.length < MIN_CHARS) return
  if (isApproved(target.element, text)) return

  /**
   * Audit mode: look, record, and let the send go.
   *
   * Deliberately before `preventDefault`. A policy that enforces nothing has
   * no business interrupting anybody, not even for the sub-millisecond it
   * takes to be told there is nothing to do — the point of an audit rollout is
   * that users cannot tell it is there.
   */
  if (observeOnly) {
    void review(text, 'submit', target, false)
    return
  }

  // How the send was made, so it can be re-issued the same way if it is
  // cleared. Captured before preventDefault, while the event is still live.
  const control = sendControlFrom(event, adapter)

  // Hold the send until the check comes back. This is the one place the
  // extension is allowed to interrupt, and it is why paste can stay lenient.
  // The rules answer in well under a millisecond, so on clean text this is
  // imperceptible and the send goes straight through.
  event.preventDefault()
  event.stopPropagation()

  try {
    const response = await review(text, 'submit', target, true, control)
    if (response && response.decision === 'allow') {
      approve(target.element, text)
      resend(target, control)
    }
  } catch (cause) {
    // Everything from here on runs after the send was cancelled, so a throw
    // in the banner or the editor would leave the message deleted: cancelled,
    // unsent, and with nothing on screen to say so. Eating somebody's prompt
    // is the worst outcome available, so fail open — but only when no banner
    // made it up. If one did, the user has the controls and it is theirs to
    // resolve, not ours to send behind them.
    warnOnce(
      'submit-threw',
      `the check failed after the send was already held, so this prompt was ` +
        `re-sent UNCHECKED rather than discarded. Please report it.`,
    )
    console.warn('[ai-safe] submit interception failed', cause)
    if (!bannerIsOpen()) {
      approve(target.element, text)
      resend(target, control)
    }
  }
}

/**
 * The file guard's dependencies.
 *
 * Injected rather than imported by `files.ts` so that module can be tested
 * without a worker, a shadow root or a banner — and so the rule this script
 * lives by still holds there: it reads, it asks, it renders, and it decides
 * nothing.
 */
const fileDeps: FileGuardDeps = {
  check: (text) =>
    ask<CheckResponse>({ type: 'check', reason: 'file', text, host: location.hostname }),

  clean: (text, mode) =>
    ask<SanitizeResponse>(
      { type: 'sanitize', text, host: location.hostname, mode },
      DEEP_TIMEOUT_MS,
    ),

  // Documents go to the offscreen reader, which owns the parsers. The budget
  // is the long one: opening a spreadsheet is not a sub-millisecond operation
  // and the user is watching a file they just dropped, not a held keystroke.
  parse: (name, bytes, mode) =>
    ask<AttachmentResponse>(
      { type: 'attachment', name, bytes, host: location.hostname, mode },
      DEEP_TIMEOUT_MS,
    ),

  present: ({ file, response, allowAnyway }) =>
    new Promise((resolve) => {
      showBanner({
        response: {
          ...response,
          // The banner was written for prompts. Naming the file is the whole
          // difference: "check this before sending" is useless when the thing
          // being sent is an attachment the user may have forgotten they
          // attached.
          headline:
            response.decision === 'block'
              ? `Sensitive information in ${file.name}`
              : `Check ${file.name} before attaching it`,
        },
        allowSendAnyway: allowAnyway,
        onAction: (action) => {
          dismissBanner()
          showing = null
          if (action === 'send-anyway') resolve('anyway')
          else if (action === 'redact' || action === 'pseudonymize') resolve('clean')
          else resolve('cancel')
        },
      })
    }),

  warn: warnOnce,
}

/**
 * Attach to the page.
 *
 * Kept out of module scope so importing this file does nothing: the listeners
 * are `document`-level and capture-phase, and a module that installs them on
 * import cannot be exercised by a test without three suites fighting over one
 * document.
 *
 * Capture phase on purpose — a site that stops propagation on its own
 * composer would otherwise hide the send from us entirely.
 */
export function install(): void {
  console.info(
    `[ai-safe] active on ${adapter.label} (${adapter.id} adapter). ` +
      `Paste warns, send is checked. Nothing leaves this device.`,
  )

  if (APP_ORIGINS.includes(location.origin)) {
    void collectHandoff()
  }

  /**
   * One config fetch, at load.
   *
   * `storage.managed` is a policy push rather than a hot value, so the worker
   * resolves it once and answers this synchronously. Asking per send would put
   * a round trip on the path that has to stay imperceptible.
   */
  void (async () => {
    const config = await ask<ConfigResponse>({ type: 'config' })
    if (!config) return
    observeOnly = config.observeOnly
    managedByPolicy = config.managed
    if (managedByPolicy) {
      console.info(
        `[ai-safe] configuration is managed by your organisation` +
          `${observeOnly ? ' (audit mode: nothing is blocked)' : ''}.`,
      )
    }
  })()

  // Registered on `window` and `document` at capture, so this is first in the
  // propagation path rather than merely early in it — see `listen.ts`.
  listenFirst('paste', (e) => onPaste(e as ClipboardEvent))
  listenFirst('keydown', (e) => void intercept(e))
  listenFirst('click', (e) => void intercept(e))

  // Attachments. The composer was never the only way in.
  installFileInterceptors(fileDeps)
}

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
    if (reason === 'submit') approve(target.element, text)
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
    overridden = normalise(text)
    approve(target.element, text)
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
  // Both strings, because they can differ. `cleaned.text` is what we asked
  // for; the read-back is what the editor actually kept. Approving only the
  // first is what warned the user twice about our own output.
  approve(target.element, cleaned.text)
  approve(target.element, target.read())
  showing = null

  // Never silently. The user must know their words changed.
  showCleaned(cleaned.replaced.length, () => {
    dismissBanner()
  })
}
