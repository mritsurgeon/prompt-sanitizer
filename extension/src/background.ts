import type { Finding } from '@/engine/types'
import { scan } from '@/engine/detect'
import { registerMetricsSink } from '@/engine/metrics'
import { installAllowlist } from './allowlist'
import { readManaged, resolveManaged, UNMANAGED, type Resolved } from './managed'
import {
  loadSession,
  pseudonymsFrom,
  recordSubstitutions,
  sessionKeyFrom,
  watchTabs,
} from './hydration'
import { LocalSource } from '@/metrics/localSource'
import type { OffscreenAttachmentRequest } from './offscreen'
import {
  evaluate,
  getPolicy,
  registerPolicy,
  unavailableOutcome,
} from '@/engine/policy'
import { sanitize } from '@/engine/sanitize'
import { runtime } from './browser'
import { APP_ORIGIN } from './config'
import { confirmedFindings, runDeepCheck, toWire } from './deep'
import type {
  OffscreenConfirmRequest,
  OffscreenConfirmResponse,
  OffscreenDeepRequest,
} from './offscreen'
import {
  EMPTY_METRICS,
  MAX_TEXT_BYTES,
  type CheckRequest,
  type CheckResponse,
  type DeepCheckRequest,
  type DeepCheckResponse,
  type HandoffRequest,
  type HandoffResponse,
  type Metrics,
  type AttachmentRequest,
  type AttachmentResponse,
  type Request,
  type Response,
  type SanitizeRequest,
  type SanitizeResponse,
  type StatusResponse,
} from './protocol'

/**
 * The enforcement point's brain — which is to say, none of it.
 *
 * This worker owns the engine and nothing else. It does not know what ChatGPT
 * looks like, it does not decide how to render a warning, and it never talks to
 * the network. Content scripts ask it questions; it answers with data.
 *
 * The engine is imported, not reimplemented and not called over a socket. It is
 * the same `src/engine` the desktop app uses, so there is exactly one detector,
 * one confidence model and one sanitizer in this project. That also means the
 * fast path costs a function call rather than a round trip, which is what keeps
 * a safe paste indistinguishable from an unprotected one.
 *
 * ## Two stages, and the second one is earned
 *
 *   1. **Rules.** Synchronous, sub-millisecond, runs on everything. If it finds
 *      nothing, nothing happens at all — no banner, no delay, no model. This is
 *      the overwhelming majority of prompts and it has to stay invisible.
 *
 *   2. **A closer look.** Runs *only* after stage one has already flagged
 *      something, and only on the findings the rules could not settle. By then
 *      the banner is on screen and the user is reading it, so the cost is spent
 *      against time that was going to pass anyway.
 *
 * Stage two never gates the answer. Stage one's verdict is complete and
 * actionable on its own; the closer look refines it in place, usually by
 * *withdrawing* findings rather than adding them.
 */

const VERSION = '0.1.0'

/** Rolling window for latency percentiles. Counts only, never content. */
const LATENCY_SAMPLES = 200

/**
 * The popup's counters.
 *
 * Held in `storage.session` and not merely in this worker, because MV3
 * terminates the worker after roughly thirty seconds idle — which is most of
 * the time between prompts. Kept in memory alone, the counters reset to zero
 * whenever the user is not actively typing, so the popup showed zeros after
 * a conversation that had plainly been checked.
 *
 * `storage.session` rather than `storage.local`: these are session counts,
 * and this extension writes nothing to disk.
 */
const METRICS_KEY = 'metrics'

let metrics: Metrics = { ...EMPTY_METRICS, latencies: [] }

/** Restored before the first message is answered; zeros until then. */
const metricsReady = (async () => {
  try {
    const area = (runtime.storage as { session?: chrome.storage.StorageArea })?.session
    const bag = (await area?.get(METRICS_KEY)) as { metrics?: Metrics } | undefined
    if (bag?.metrics) metrics = { ...EMPTY_METRICS, ...bag.metrics }
  } catch {
    // Starting from zero is the harmless failure.
  }
})()

/**
 * Written back on a short timer rather than on every increment.
 *
 * A counter bump happens on the path that has to stay imperceptible, and
 * `storage.session` is an async IPC — so writes are coalesced. Losing the last
 * two seconds of counts to an eviction costs a number in a popup; paying for
 * a round trip per keystroke costs the thing the product is for.
 */
let flushTimer: ReturnType<typeof setTimeout> | null = null

function persistMetrics(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void (async () => {
      try {
        const area = (runtime.storage as { session?: chrome.storage.StorageArea })
          ?.session
        await area?.set({ [METRICS_KEY]: metrics })
      } catch {
        // See above: a lost counter is not worth reporting.
      }
    })()
  }, 2000)
  const handle = flushTimer as unknown as { unref?: () => void }
  handle.unref?.()
}

/**
 * Performance metrics for the escalation path, on this device only.
 *
 * The counters above are the popup's; this is the envelope the console reads.
 * IndexedDB rather than the worker's memory because a service worker is
 * evicted after thirty seconds idle, and a metric that dies with the worker
 * cannot answer "what does the cold start cost our users".
 *
 * A short buffer window still loses the last few events to an eviction. That
 * is an accepted gap rather than an unknown one: percentiles over a session
 * survive it, and paying a synchronous write per escalation to close it would
 * put storage latency on the path being measured.
 */
registerMetricsSink(new LocalSource())

/**
 * The user's allowlist, if they have one.
 *
 * Fire and forget: it resolves before any realistic first prompt, and until it
 * does the engine suppresses nothing — which is the safe direction, and the
 * default anyway.
 */
/**
 * Enterprise configuration, resolved once at startup.
 *
 * Held here rather than re-read per message: `storage.managed` is a policy
 * push, not a hot value, and a worker that re-reads it on every keystroke is
 * paying for something that changes at most daily.
 *
 * `configured` is what the content script and the popup await. Until it
 * settles the defaults apply, which is the conservative direction.
 */
let managed: Resolved = UNMANAGED

const configured = (async () => {
  managed = resolveManaged(await readManaged())
  registerPolicy(managed.policy)
  await installAllowlist(managed)
})()

void configured

// Drop a conversation's stand-ins when its tab closes. They are the only place
// the user's real names are held.
watchTabs()

function record(ms: number) {
  metrics.latencies.push(ms)
  if (metrics.latencies.length > LATENCY_SAMPLES) metrics.latencies.shift()
  persistMetrics()
}

/**
 * The fast path.
 *
 * Synchronous `scan` only — no confirmer, no model, no document classifier.
 * A paste has to feel like a paste, and the overwhelming majority contain
 * nothing at all. Escalation belongs at submit time, where a pause is
 * affordable and the user has stopped typing.
 */
function check(request: CheckRequest): CheckResponse {
  const started = performance.now()

  if (request.text.length > MAX_TEXT_BYTES) {
    const outcome = unavailableOutcome(getPolicy())
    return {
      type: 'checked',
      decision: outcome.decision,
      headline: 'Too large to check',
      summary: 'this content is bigger than the checker will accept',
      findings: [],
      degraded: 'text exceeded the size limit',
      ms: performance.now() - started,
    }
  }

  const result = scan(request.text)
  const outcome = evaluate(result, getPolicy())
  const ms = performance.now() - started

  metrics.checked += 1
  if (outcome.decision === 'allow') metrics.allowed += 1
  if (outcome.decision === 'warn') metrics.warned += 1
  if (outcome.decision === 'block') metrics.blocked += 1
  record(ms)

  return {
    type: 'checked',
    decision: outcome.decision,
    headline: outcome.headline,
    summary: outcome.summary,
    findings: outcome.drivers.map(toWire),
    ms,
    // Worth a closer look only if the rules actually hesitated. A page of
    // certain findings has nothing left to confirm.
    deeperAvailable:
      outcome.decision !== 'allow' &&
      (result.ambiguous.length > 0 || result.recoverable.length > 0),
  }
}

/**
 * The offscreen document, created once and kept.
 *
 * Chrome allows exactly one, so this is idempotent and tolerates the
 * already-exists race that happens when two tabs flag something at the same
 * moment. Returns false where the API does not exist — Firefox has no
 * equivalent — and stage two then runs in this worker instead.
 */
let offscreenReady: Promise<boolean> | null = null

function ensureOffscreen(): Promise<boolean> {
  if (offscreenReady) return offscreenReady

  offscreenReady = (async () => {
    const api = (
      runtime as typeof chrome & { offscreen?: typeof chrome.offscreen }
    ).offscreen
    if (!api) return false

    try {
      if (await api.hasDocument()) return true
      await api.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS' as chrome.offscreen.Reason],
        justification:
          'Keeps the local entity-recognition model resident between prompts; ' +
          'a service worker is terminated on idle and would reload it each time.',
      })
      return true
    } catch (cause) {
      // A concurrent create is a race, not a failure — the document we wanted
      // now exists. Anything else means stage two runs in the worker.
      const message = cause instanceof Error ? cause.message : ''
      if (message.includes('Only a single offscreen')) return true
      console.warn(
        '[ai-safe] no offscreen document, so the closer look runs in the ' +
          'worker without the model.',
        cause,
      )
      return false
    }
  })()

  return offscreenReady
}

/**
 * Stage two — the closer look.
 *
 * Only the findings the rules could not settle are examined, and only the
 * window around each one, never the whole prompt.
 *
 * Preferably in the offscreen document, where GLiNER can stay resident between
 * prompts. Where that is unavailable — Firefox, or a create that failed — the
 * identical code runs here with the deterministic deep-context confirmer,
 * which needs no files and cannot fail.
 *
 * So a second opinion always happens, and `confirmedBy` reports which one gave
 * it. Measured on the two held-out ambiguity sets: deep-context 46/48, GLiNER
 * 47/48, and GLiNER's one miss is a person relabelled as an organisation — the
 * value is still detected and still redacted.
 */
/**
 * Say it once, and say which failure it was.
 *
 * The model lives in the offscreen document and nowhere else, so when the
 * relay does not answer, stage two runs here — correctly, but without the
 * model, and every recovered name the model would have found is silently
 * absent. That is precisely the failure this project says it will not have:
 * a confirmer that has stopped running looks exactly like one that is
 * working, and the findings quietly get worse.
 */
const announced = new Set<string>()

function announce(key: string, message: string): void {
  if (announced.has(key)) return
  announced.add(key)
  console.warn(`[ai-safe] ${message}`)
}

/**
 * Ask the offscreen document, or answer `null`.
 *
 * Shared by everything that needs the model, because the model is only ever
 * in one place. Anything that answers in the worker instead answers without
 * it — correctly, and with worse recall — so each caller has to decide what
 * to do with `null` rather than have a silent fallback chosen for it.
 */
async function relayToOffscreen<TResponse, TRequest extends { type: string }>(
  message: TRequest,
): Promise<TResponse | null> {
  if (!(await ensureOffscreen())) {
    announce(
      'offscreen-absent',
      `there is no offscreen document, so the model is unavailable. Expected ` +
        `on Firefox; on Chrome it means createDocument failed.`,
    )
    return null
  }

  return new Promise<TResponse | null>((resolve) => {
    try {
      runtime.runtime.sendMessage(message, (response: TResponse) => {
        const failure = runtime.runtime.lastError
        if (failure) {
          announce(
            'offscreen-silent',
            `the offscreen document did not answer (${failure.message ?? 'no reason given'}), ` +
              `so this ran WITHOUT the model. Open it from ` +
              `chrome://extensions → Inspect views → offscreen.html; if the ` +
              `page threw while loading, its listener never registered.`,
          )
        }
        resolve(failure ? null : (response ?? null))
      })
    } catch (cause) {
      announce(
        'offscreen-throw',
        `relaying to the offscreen document threw, so this ran WITHOUT the ` +
          `model: ${cause instanceof Error ? cause.message : cause}`,
      )
      resolve(null)
    }
  })
}

async function deepCheck(request: DeepCheckRequest): Promise<DeepCheckResponse> {
  metrics.escalations += 1
  persistMetrics()

  const relayed = await relayToOffscreen<DeepCheckResponse, OffscreenDeepRequest>({
    type: 'offscreen-deep-check',
    text: request.text,
  })

  if (relayed) {
    record(relayed.ms)
    return relayed
  }

  // Answer here rather than leaving the user with nothing — but `announce`
  // has already said the model was not involved.
  const result = await runDeepCheck(request.text)
  record(result.ms)
  return result
}

/**
 * The findings to rewrite from, decided where the model lives.
 *
 * Falls back to answering in the worker only when the relay fails, which is
 * Firefox by design and a broken offscreen document otherwise. The rewrite
 * is then no worse than stage one, and `announce` has already said so.
 */
async function confirmedForClean(text: string): Promise<Finding[]> {
  const relayed = await relayToOffscreen<OffscreenConfirmResponse, OffscreenConfirmRequest>({
    type: 'offscreen-confirm',
    text,
  })
  return relayed?.findings ?? (await confirmedFindings(text))
}

/**
 * Cleaning reuses the app's sanitizer verbatim — placeholders, consistency and
 * all. `deep` re-runs the escalation first so the cleanup acts on the findings
 * the user was actually shown, rather than silently reverting to stage one's.
 *
 * "Re-runs" has to mean *in the offscreen document*. `registerLocalModel` is
 * called there and nowhere else, so an escalation awaited here resolves to
 * the deterministic confirmer: correct, and blind to the names the model
 * exists to recover. The banner was relayed and this was not, so the two
 * disagreed about the same text — "Closer look caught 2 more" above a
 * rewrite that masked none of them.
 */
async function clean(
  request: SanitizeRequest,
  sessionId: string | null,
): Promise<SanitizeResponse> {
  const started = performance.now()
  const findings = request.deep
    ? await confirmedForClean(request.text)
    : scan(request.text).findings

  /**
   * Stand-ins already handed out in this conversation.
   *
   * Without this, turn two calls the same person something different and the
   * model loses track of who is who — which is the entire reason nickname mode
   * exists. Loaded from `storage.session` rather than worker memory because
   * the worker is evicted between turns.
   */
  const carry = sessionId ? pseudonymsFrom(await loadSession(sessionId)) : undefined

  const cleaned = sanitize(request.text, findings, {
    mode: request.mode ?? 'redact',
    carry,
  })

  // Recorded so the model's answer can be put back into the user's own words.
  // Fire and forget: a lost mapping costs a manual find-and-replace, and must
  // not cost them the cleaning itself.
  if (sessionId) void recordSubstitutions(sessionId, cleaned.replacements)

  metrics.sanitized += 1
  const ms = performance.now() - started
  record(ms)

  return {
    type: 'sanitized',
    text: cleaned.text,
    replaced: cleaned.replacements.map((r) => toWire(r.finding)),
    ms,
  }
}

/**
 * Hand the prompt to the web app, where the full three-mode UI lives.
 *
 * The text goes through session storage, never through the URL. A query string
 * ends up in history, in the omnibox, in shell logs and in anything that
 * samples open tabs — which is exactly the exposure this tool exists to
 * prevent. Session storage is cleared when the browser closes and is not
 * readable by any page; the content script on the app's own origin collects it
 * and clears it immediately.
 */
async function handoff(request: HandoffRequest): Promise<HandoffResponse> {
  try {
    await runtime.storage.session.set({ handoff: request.text })
    await runtime.tabs.create({ url: `${APP_ORIGIN}/` })
    return { type: 'handed-off', ok: true }
  } catch (cause) {
    return {
      type: 'handed-off',
      ok: false,
      reason: cause instanceof Error ? cause.message : 'could not open the app',
    }
  }
}

/** Collected once by the app's own tab, then dropped. */
async function takeHandoff(): Promise<string | null> {
  try {
    const stored = (await runtime.storage.session.get('handoff')) as {
      handoff?: string
    }
    if (!stored.handoff) return null
    await runtime.storage.session.remove('handoff')
    return stored.handoff
  } catch {
    return null
  }
}

function status(): StatusResponse {
  return { type: 'status', ready: true, version: VERSION, metrics }
}

/** The reply a caller gets when the engine itself threw. Never a clean bill. */
function failed(cause: unknown): CheckResponse {
  const outcome = unavailableOutcome(getPolicy())
  return {
    type: 'checked',
    decision: outcome.decision,
    headline: outcome.headline,
    summary: outcome.summary,
    findings: [],
    degraded: cause instanceof Error ? cause.message : 'check failed',
    ms: 0,
  }
}

/**
 * An attachment, relayed to where the parsers live.
 *
 * The worker does not read the file itself: `extract.ts` pulls in `xlsx`,
 * `jszip` and `pdfjs-dist`, and a service worker is woken constantly, so
 * parsing 3 MB of parser on every wake to serve the rare attachment is the
 * wrong trade. The offscreen document is created on demand and outlives the
 * worker, which is where that weight belongs.
 *
 * Firefox has no offscreen API, so there it says so rather than guessing. An
 * attachment that could not be read is reported as unread — never as clean.
 */
async function attachment(request: AttachmentRequest): Promise<AttachmentResponse> {
  const unavailable = (why: string): AttachmentResponse => ({
    type: 'attachment-checked',
    decision: 'warn',
    headline: `Could not check ${request.name}`,
    summary: why,
    findings: [],
    ms: 0,
    unreadable: why,
  })

  if (!(await ensureOffscreen())) {
    return unavailable('this browser cannot read attachments in the extension')
  }

  const message: OffscreenAttachmentRequest = { type: 'offscreen-attachment', request }
  const relayed = await new Promise<AttachmentResponse | null>((resolve) => {
    try {
      const returned = runtime.runtime.sendMessage(
        message,
        (response: AttachmentResponse) => {
          resolve(runtime.runtime.lastError ? null : (response ?? null))
        },
      ) as unknown as Promise<AttachmentResponse> | undefined
      if (typeof returned?.then === 'function') {
        returned.then((response) => resolve(response ?? null), () => resolve(null))
      }
    } catch {
      resolve(null)
    }
  })

  if (!relayed) return unavailable('the attachment reader did not respond')

  metrics.checked += 1
  if (relayed.decision === 'warn') metrics.warned += 1
  if (relayed.decision === 'block') metrics.blocked += 1
  if (relayed.cleaned) metrics.sanitized += 1
  // This path never called `record`, so it never persisted — an attachment
  // was checked and the popup still said zero.
  persistMetrics()

  return relayed
}

runtime.runtime.onMessage.addListener(
  (message: Request, sender, sendResponse: (r: Response) => void) => {
    // Stage one and status answer synchronously — that is the whole point of
    // stage one, and holding the port open for them would add a round trip to
    // the path that has to stay instant.
    try {
      switch (message?.type) {
        case 'check':
          sendResponse(check(message))
          return false
        case 'status':
          // Held open until the counters are back from storage: answering
          // synchronously here is what showed zeros after an eviction.
          void metricsReady.then(() => sendResponse(status()))
          return true
        case 'config':
          // Synchronous: the content script asks once at load and must not
          // wait on a round trip before it can decide whether to hold a send.
          sendResponse({
            type: 'config',
            observeOnly: managed.observeOnly,
            managed: managed.managed,
            allowUserOverrides: managed.allowUserOverrides,
          })
          return false
        default:
          break
      }
    } catch (cause) {
      sendResponse(failed(cause))
      return false
    }

    // Everything below is asynchronous, so the port has to stay open until the
    // promise settles. `return true` is what does that; without it Chrome
    // closes the channel and the caller sees an undefined response.
    const pending: Promise<Response> | null =
      message?.type === 'deep-check'
        ? deepCheck(message)
        : message?.type === 'sanitize'
          ? clean(message, sessionKeyFrom(sender))
          : message?.type === 'handoff'
            ? handoff(message)
            : message?.type === 'attachment'
          ? attachment(message)
          : message?.type === 'take-handoff'
              ? takeHandoff().then(
                  (text): Response => ({ type: 'handoff-text', text }),
                )
              : null

    if (!pending) return false

    pending.then(sendResponse, (cause) => sendResponse(failed(cause)))
    return true
  },
)
