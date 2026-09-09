import type { MetricsPhase } from '../metrics'

/**
 * The execution guard: latency budgets and the circuit breaker.
 *
 * Escalation is allowed to be slow. It is not allowed to be slow *while
 * somebody is waiting*, and it is not allowed to keep being slow once this
 * machine has demonstrated it cannot meet the budget.
 *
 * The important asymmetry is that a timeout cannot cancel anything. ONNX
 * Runtime Web has no cancellation, so "timed out" means *we stopped waiting* —
 * the inference is still running, still holding WASM memory, and will still
 * resolve. Every decision here follows from that: the lock is held until the
 * abandoned work settles, a cold start that overruns is treated as a warm-up
 * rather than a fault, and repeated real failures stop us trying at all.
 */

/** Distinguishable from any value a confirmer could legitimately return. */
export const TIMED_OUT = Symbol('escalation-timed-out')

export interface Budget {
  /** How long to wait before keeping the fast path instead. */
  ms: number
  /**
   * Whether to escalate at all when the confirmer is not resident.
   *
   * False for a held send: loading 183 MB of weights to answer a keystroke
   * somebody is waiting on is the wrong trade, and the same reasoning the gate
   * already applies to recovery candidates applies here. The load is started
   * in the background instead, so the next send is warm.
   */
  attemptWhenCold: boolean
}

/**
 * Budgets per surface. These differ by two orders of magnitude, which is the
 * whole reason `phase` exists: a single number would either strangle the
 * background path or hang the foreground one.
 */
const BUDGETS: Record<MetricsPhase, { warm: number; cold: number | null }> = {
  // The send is held and the user is mid-action.
  'submit-gate': { warm: 150, cold: null },
  // A banner is already on screen and actionable; nobody is waiting.
  banner: { warm: 2_000, cold: 8_000 },
  // The scan overlay is up and being watched.
  overlay: { warm: 500, cold: 10_000 },
  // A file was dropped; reading it already took a moment.
  file: { warm: 1_000, cold: 10_000 },
  // Benchmarks and tests must measure the engine, not trip a stopwatch.
  harness: { warm: 60_000, cold: 120_000 },
  unknown: { warm: 2_000, cold: 8_000 },
}

export function budgetFor(phase: MetricsPhase, cold: boolean): Budget {
  const entry = BUDGETS[phase] ?? BUDGETS.unknown
  if (!cold) return { ms: entry.warm, attemptWhenCold: true }
  return {
    ms: entry.cold ?? entry.warm,
    attemptWhenCold: entry.cold !== null,
  }
}

/**
 * Stop waiting after `ms`, and say so with a sentinel rather than `null`.
 *
 * `null` would be indistinguishable from a confirmer that legitimately
 * resolved with nothing, which is a real state — the difference between "no
 * answer yet" and "no findings" is the difference between keeping a finding
 * and dropping it.
 */
export function raceBudget<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout>
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
    // Never hold a Node process open on account of a budget timer.
    const handle = timer as unknown as { unref?: () => void }
    handle.unref?.()
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

/**
 * The circuit breaker.
 *
 * After this many consecutive hard failures, stop escalating for the rest of
 * the session. Predictably deterministic beats intermittently slow: a machine
 * that cannot run the model is better served by the deep-context confirmer
 * than by paying the full budget on every scan to reach the same fallback.
 */
export const FAILURE_THRESHOLD = 3

let consecutiveFailures = 0
let tripped = false

/**
 * What counts as a failure, and — more importantly — what does not.
 *
 * `superseded` is normal operation: the user typed again. Counting it would
 * let three quick keystrokes disable the model for the session, which is the
 * opposite of what a breaker is for.
 *
 * `cold-timeout` is also not a fault. The load that overran is still running
 * and will finish, so the very next escalation is warm — the overrun warmed
 * the model rather than failing to. Counting it would trip the breaker on
 * every fresh session, permanently, before the model ever got a chance to be
 * fast.
 */
export type FailureKind = 'threw' | 'warm-timeout'

export function noteSuccess(): void {
  consecutiveFailures = 0
}

export function noteFailure(kind: FailureKind): void {
  consecutiveFailures += 1
  if (consecutiveFailures >= FAILURE_THRESHOLD) tripped = true
  if (tripped) {
    console.warn(
      `[ai-safe] escalation is disabled for this session after ` +
        `${consecutiveFailures} consecutive failures (last: ${kind}). ` +
        `Findings still come from the rules and the deterministic confirmer.`,
    )
  }
}

/** True once the breaker has tripped; stays true for the session. */
export function isCircuitOpen(): boolean {
  return tripped
}

/** Test-only. */
export function resetGuard(): void {
  consecutiveFailures = 0
  tripped = false
}
