import { scan, scanWithConfirmation } from '@/engine/detect'
import { DEFAULT_POLICY, evaluate, unavailableOutcome } from '@/engine/policy'
import { sanitize } from '@/engine/sanitize'
import { runtime } from './browser'
import { APP_ORIGIN } from './config'
import { runDeepCheck, toWire } from './deep'
import type { OffscreenDeepRequest } from './offscreen'
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

const metrics: Metrics = { ...EMPTY_METRICS, latencies: [] }

function record(ms: number) {
  metrics.latencies.push(ms)
  if (metrics.latencies.length > LATENCY_SAMPLES) metrics.latencies.shift()
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
    const outcome = unavailableOutcome(DEFAULT_POLICY)
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
  const outcome = evaluate(result, DEFAULT_POLICY)
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
async function deepCheck(request: DeepCheckRequest): Promise<DeepCheckResponse> {
  metrics.escalations += 1

  if (await ensureOffscreen()) {
    const relayed = await new Promise<DeepCheckResponse | null>((resolve) => {
      const message: OffscreenDeepRequest = {
        type: 'offscreen-deep-check',
        text: request.text,
      }
      try {
        runtime.runtime.sendMessage(message, (response: DeepCheckResponse) => {
          resolve(runtime.runtime.lastError ? null : (response ?? null))
        })
      } catch {
        resolve(null)
      }
    })

    if (relayed) {
      record(relayed.ms)
      return relayed
    }
    // Fall through and answer here rather than leaving the user with nothing.
  }

  const result = await runDeepCheck(request.text)
  record(result.ms)
  return result
}

/**
 * Cleaning reuses the app's sanitizer verbatim — placeholders, consistency and
 * all. `deep` re-runs the escalation first so the cleanup acts on the findings
 * the user was actually shown, rather than silently reverting to stage one's.
 */
async function clean(request: SanitizeRequest): Promise<SanitizeResponse> {
  const started = performance.now()
  const result = request.deep
    ? await scanWithConfirmation(request.text)
    : scan(request.text)
  const cleaned = sanitize(request.text, result.findings, {
    mode: request.mode ?? 'redact',
  })

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
  const outcome = unavailableOutcome(DEFAULT_POLICY)
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

runtime.runtime.onMessage.addListener(
  (message: Request, _sender, sendResponse: (r: Response) => void) => {
    // Stage one and status answer synchronously — that is the whole point of
    // stage one, and holding the port open for them would add a round trip to
    // the path that has to stay instant.
    try {
      switch (message?.type) {
        case 'check':
          sendResponse(check(message))
          return false
        case 'status':
          sendResponse(status())
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
          ? clean(message)
          : message?.type === 'handoff'
            ? handoff(message)
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
