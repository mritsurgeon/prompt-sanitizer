import { MEDIUM_THRESHOLD, tierFor } from '../context'
import { charBucket, emit } from '../metrics'
import type { MetricsPhase, PerformanceEnvelope } from '../metrics'
import type { Finding } from '../types'
import { deepContextConfirmer } from './deepContext'
import {
  budgetFor,
  isCircuitOpen,
  noteFailure,
  noteSuccess,
  raceBudget,
  TIMED_OUT,
} from './guard'
import { acquire, isCurrent, nextEpoch } from './scheduler'
import type {
  ConfirmationRequest,
  ConfirmationVerdict,
  LocalModelDetector,
} from './types'

export type {
  LocalModelDetector,
  ModelRuntime,
  ConfirmationRequest,
  ConfirmationVerdict,
  DiscoveredEntity,
} from './types'

export { resetScheduler } from './scheduler'
export {
  budgetFor,
  FAILURE_THRESHOLD,
  isCircuitOpen,
  resetGuard,
  type Budget,
} from './guard'

/**
 * Registry for the second-stage confirmer.
 *
 * Exactly one is active. The default is the deterministic deep-context pass,
 * which needs no files and cannot fail. A provisioned local model can replace
 * it at startup via `registerLocalModel` without any other file changing.
 */
let active: LocalModelDetector = deepContextConfirmer

export function registerLocalModel(detector: LocalModelDetector): void {
  active = detector
}

export function getLocalModel(): LocalModelDetector {
  return active
}

export function resetLocalModel(): void {
  active = deepContextConfirmer
}

/**
 * Load the confirmer ahead of a scan we know is coming.
 *
 * Attaching a document is a strong signal: reading it already takes a moment,
 * the user has not clicked anything yet, and a document large enough to open is
 * very likely to contain something ambiguous. Starting the load during that
 * dead time hides most of the one-off cost, which is the only part anybody
 * notices.
 *
 * Deliberately not called when text is pasted — that path is instant, and
 * loading a model for it would put weights on the normal path for no gain.
 *
 * Fire and forget: this never throws and never blocks. If it fails, the scan
 * falls back exactly as it would have.
 */
export function warmUp(): void {
  const model = active
  if (model.loaded) return

  void (async () => {
    try {
      if (await model.isAvailable()) await model.load()
    } catch {
      // The scan will report the failure properly if it ever needs the model.
    }
  })()
}

/** How much text the confirmer gets to see around a candidate. */
export const WINDOW_RADIUS = 160

/** Snap a window to word boundaries so the confirmer never sees half a word. */
function windowFor(text: string, start: number, end: number) {
  let from = Math.max(0, start - WINDOW_RADIUS)
  let to = Math.min(text.length, end + WINDOW_RADIUS)
  while (from > 0 && /\w/.test(text[from - 1])) from -= 1
  while (to < text.length && /\w/.test(text[to])) to += 1
  return { from, to }
}

/**
 * How windows are cut for the confirmer.
 *
 * Candidates in neighbouring sentences produce windows that overlap almost
 * entirely, so the model reads the same prose once per candidate. On a dense
 * document, eleven candidates produced eleven windows covering 2 978
 * characters of a 502-character region and found 73 spans for what were really
 * ten entities. Merging them is 2.3x faster.
 *
 * **It is off, because it costs recall, and recall is the product.**
 *
 * That is a reversal. A first pass measured it on one hand-written document,
 * found 13 findings before and 13 after, and concluded it was free. It is not:
 * scored with GLiNER against 564 labelled positives across 90 dense documents
 * in the generated corpus, the cap trades recall for windows monotonically.
 *
 * | cap | windows | recall | label accuracy |
 * |-----|---------|--------|----------------|
 * | off | 340     | **73.9%** | 95.9%       |
 * | 250 | 319     | 72.7%  | 96.8%          |
 * | 350 | 258     | 70.7%  | 96.7%          |
 * | 800 | 258     | 62.6%  | 98.3%          |
 *
 * Longer sequences make the model more conservative about *finding* an entity
 * and better informed about *labelling* one — which is coherent, and the wrong
 * way round for this product. A missed finding is a leak; a mislabelled one is
 * still redacted.
 *
 * The speed it buys is also spent in the wrong place. Stage two runs behind a
 * banner that is already on screen with a two-second budget, and unmerged
 * dense documents came in at 443 ms. Nothing was waiting for the 2.3x.
 *
 * Kept, tested and switchable because the trade is real and a future
 * checkpoint may sit differently on it — a model less sensitive to sequence
 * length would make this free. `setWindowStrategy({ merge: true })` turns it
 * on, and `npm run check:documents -- --gliner --density dense` is how to find
 * out what that costs.
 */
export interface WindowStrategy {
  /** Merge overlapping windows into one call. */
  merge: boolean
  /**
   * Hard ceiling on a merged window. See the table above — this is the
   * accuracy knob, not a safety margin, and raising it loses findings.
   */
  maxChars: number
}

const DEFAULT_STRATEGY: WindowStrategy = { merge: false, maxChars: 350 }

let strategy: WindowStrategy = { ...DEFAULT_STRATEGY }

export function setWindowStrategy(next: Partial<WindowStrategy>): void {
  strategy = { ...strategy, ...next }
}

export function getWindowStrategy(): WindowStrategy {
  return { ...strategy }
}

export function resetWindowStrategy(): void {
  strategy = { ...DEFAULT_STRATEGY }
}

interface Candidate {
  finding: Finding
  unresolved: boolean
}

/**
 * Turn candidates into confirmation requests, one window per request or one
 * window per overlapping run depending on the strategy.
 */
function buildRequests(text: string, items: Candidate[]): ConfirmationRequest[] {
  const spans = items.map(({ finding }) =>
    windowFor(text, finding.start, finding.end),
  )

  if (!strategy.merge) {
    return items.map(({ finding, unresolved }, i) => ({
      id: finding.id,
      value: finding.value,
      category: finding.category,
      window: text.slice(spans[i].from, spans[i].to),
      offset: finding.start - spans[i].from,
      windowStart: spans[i].from,
      unresolved,
    }))
  }

  // Merge only *overlapping* spans. Two candidates far apart in a document
  // have nothing to say about each other, and bridging the gap would hand
  // over text neither of them needed.
  const order = items
    .map((_, i) => i)
    .sort((a, b) => items[a].finding.start - items[b].finding.start)

  const runs: Array<{ from: number; to: number; members: number[] }> = []
  for (const i of order) {
    const span = spans[i]
    const last = runs.at(-1)
    const merged = last ? Math.max(last.to, span.to) - last.from : 0
    if (last && span.from <= last.to && merged <= strategy.maxChars) {
      last.to = Math.max(last.to, span.to)
      last.members.push(i)
    } else {
      // A single span always fits: it is bounded by 2 x WINDOW_RADIUS plus the
      // value, well under any sane cap.
      runs.push({ from: span.from, to: span.to, members: [i] })
    }
  }

  const requests: ConfirmationRequest[] = []
  for (const run of runs) {
    const window = text.slice(run.from, run.to)
    for (const i of run.members) {
      const { finding, unresolved } = items[i]
      requests.push({
        id: finding.id,
        value: finding.value,
        category: finding.category,
        window,
        offset: finding.start - run.from,
        windowStart: run.from,
        unresolved,
      })
    }
  }
  return requests
}

export interface EscalationStats {
  /** How many findings were ambiguous enough to be worth a second look. */
  ambiguous: number
  /** How many low-confidence unknowns were offered for recovery. */
  offered: number
  modelId: string
  modelAvailable: boolean
  /** The single most important number: did the expensive path run at all? */
  modelInvoked: boolean
  modelLoaded: boolean
  confirmed: number
  rejected: number
  unresolved: number
  /** Rules had no opinion, the confirmer said yes — a recovered miss. */
  recovered: number
  /** The confirmer saw it and the rules never proposed it at all. */
  discovered: number
  /** Kept the finding but corrected its category. */
  relabelled: number
  /** A newer escalation replaced this one, so its answer was discarded. */
  superseded: boolean
  /** The latency budget expired; the fast path was kept. */
  timedOut: boolean
  /**
   * Escalation was skipped because the breaker is open — this machine has
   * failed repeatedly and is not asked again this session.
   */
  circuitOpen: boolean
  /**
   * Cold confirmer on a surface whose budget forbids paying a cold start.
   * The load was started in the background, so the next one is warm.
   */
  coldDeclined: boolean
  ms: number
  /** Set when the confirmer failed and the fast-path result was kept. */
  error?: string
}

export const NO_ESCALATION: EscalationStats = {
  ambiguous: 0,
  offered: 0,
  modelId: 'none',
  modelAvailable: false,
  modelInvoked: false,
  modelLoaded: false,
  confirmed: 0,
  rejected: 0,
  unresolved: 0,
  recovered: 0,
  discovered: 0,
  relabelled: 0,
  superseded: false,
  timedOut: false,
  circuitOpen: false,
  coldDeclined: false,
  ms: 0,
}

export interface ConfirmationOutcome {
  findings: Finding[]
  stats: EscalationStats
}

/** Telemetry the stats do not carry because nothing in the UI wants it. */
interface RunProfile {
  batchSize: number
  /** Distinct windows submitted — the dominant term in inference cost. */
  windowCount: number
  windowChars: number
  coldStartMs?: number
}

interface Run extends ConfirmationOutcome {
  profile: RunProfile
}

const EMPTY_PROFILE: RunProfile = { batchSize: 0, windowCount: 0, windowChars: 0 }

/** Correlation id. Not a security token — a counter with a per-session prefix. */
const SESSION = Math.random().toString(36).slice(2, 8)
let traceCounter = 0

function envelope(
  stats: EscalationStats,
  profile: RunProfile,
  model: LocalModelDetector,
  phase: MetricsPhase,
  coldStart: boolean,
): PerformanceEnvelope {
  traceCounter += 1
  return {
    traceId: `${SESSION}-${traceCounter}`,
    // Floored to the minute: a millisecond clock re-identifies a person from
    // aggregate data even when every other field is a count.
    timestamp: Math.floor(Date.now() / 60_000) * 60_000,
    phase,
    confirmerId: stats.modelId,
    ep: model.runtime?.ep ?? 'none',
    coldStart,
    coldStartMs: profile.coldStartMs,
    durationMs: stats.ms,
    superseded: stats.superseded,
    timedOut: stats.timedOut,
    circuitBreakerTripped: stats.circuitOpen,
    coldDeclined: stats.coldDeclined,
    // Explicit rather than inferred from the absence of every failure flag:
    // "did the confirmer actually run" is the one fact the latency
    // percentiles depend on, and deriving it from four booleans breaks the
    // first time a fifth is added.
    escalated: stats.modelInvoked,
    // The window cache is a later step. The field ships now so the envelope
    // does not change shape when it lands, and so "0% cache hits" is a
    // measured statement rather than a missing column.
    cacheHit: false,
    batchSize: profile.batchSize,
    windowCount: profile.windowCount,
    windowCharsBucket: charBucket(profile.windowChars),
    tokenCountBucket: model.runtime?.tokenCountBucket,
    labelCount: model.runtime?.labelCount,
    ambiguous: stats.ambiguous,
    offered: stats.offered,
    candidatesEvaluated: profile.batchSize,
    confirmed: stats.confirmed,
    rejected: stats.rejected,
    unresolved: stats.unresolved,
    recovered: stats.recovered,
    discovered: stats.discovered,
    relabelled: stats.relabelled,
    error: stats.error,
  }
}

/**
 * Runs the confirmer over the ambiguous findings only, and applies the
 * verdicts. A confirmed finding is promoted; a rejected one is dropped.
 *
 * Failure is never fatal: if the confirmer cannot load, times out or throws,
 * the fast-path findings are returned untouched and the reason is recorded.
 *
 * Serialised and epoch-guarded: one escalation runs at a time, and an
 * escalation a newer one has replaced returns the fast path rather than a
 * verdict about text the user has already changed. See `scheduler.ts`.
 */
export async function confirmAmbiguous(
  text: string,
  findings: Finding[],
  recoverable: Finding[] = [],
  declined: Array<{ start: number; end: number }> = [],
  /** Overridden only by the fallback path below. */
  model: LocalModelDetector = active,
  /** Which surface is paying for this, for the metrics envelope. */
  phase: MetricsPhase = 'unknown',
): Promise<ConfirmationOutcome> {
  const ambiguous = findings.filter((f) => f.tier === 'medium')
  const free = model.cost.bytes === 0
  const gated = ambiguous.length > 0 || free || model.loaded ? recoverable : []

  if (!ambiguous.length && !gated.length) {
    // Nothing ambiguous, nothing loaded, and — importantly — no lock taken and
    // no envelope emitted. The cheap path must not queue behind an inference,
    // and an escalation that never happened is not a data point.
    return {
      findings,
      stats: {
        ...NO_ESCALATION,
        modelId: model.id,
        modelAvailable: true,
        modelLoaded: model.loaded,
      },
    }
  }

  const epoch = nextEpoch()
  const coldStart = !model.loaded
  const budget = budgetFor(phase, coldStart)
  const queuedAt = performance.now()

  const fastPath = (over: Partial<EscalationStats>): ConfirmationOutcome => {
    const stats: EscalationStats = {
      ...NO_ESCALATION,
      ambiguous: ambiguous.length,
      offered: gated.length,
      modelId: model.id,
      modelAvailable: true,
      modelLoaded: model.loaded,
      ms: performance.now() - queuedAt,
      ...over,
    }
    emit(envelope(stats, EMPTY_PROFILE, model, phase, coldStart))
    return { findings, stats }
  }

  // --- checks that must not queue -----------------------------------------
  // Both of these are decisions not to run, so making them wait behind an
  // in-flight inference would add the very latency they exist to avoid.

  if (isCircuitOpen()) {
    return fastPath({ circuitOpen: true })
  }

  if (coldStart && !budget.attemptWhenCold) {
    // Start the load anyway: the reason not to wait is that somebody is
    // waiting, not that the model is unwanted. The next send is warm.
    warmModel(model)
    return fastPath({ coldDeclined: true })
  }

  const release = await acquire()
  let releaseOnExit = true

  try {
    if (!isCurrent(epoch)) {
      // Superseded while queued. Note what does *not* happen here: no
      // inference, and no failure recorded — the user typed again, which is
      // normal operation, and counting it would let three keystrokes trip the
      // circuit breaker.
      return fastPath({ superseded: true })
    }

    const work = runConfirmation(
      text,
      findings,
      ambiguous,
      gated,
      declined,
      model,
    )

    const raced = await raceBudget(work, budget.ms)

    if (raced === TIMED_OUT) {
      // The inference is still running — ORT cannot cancel — so the lock is
      // held until it settles. Releasing now would let the next escalation
      // overlap this one in WASM memory, which is exactly what the lock is
      // for. The caller is answered immediately regardless.
      releaseOnExit = false
      void work.then(release, release)

      // A cold start that overran is not a fault: the load is still going and
      // will finish, so this call warmed the model for the next one. Only a
      // warm overrun says the machine cannot meet the budget.
      if (!coldStart) noteFailure('warm-timeout')

      return fastPath({ timedOut: true })
    }

    if (raced.stats.error) noteFailure('threw')
    else noteSuccess()

    emit(envelope(raced.stats, raced.profile, model, phase, coldStart))
    return { findings: raced.findings, stats: raced.stats }
  } finally {
    if (releaseOnExit) release()
  }
}

/** Background load, for the surfaces that decline to wait for a cold start. */
function warmModel(model: LocalModelDetector): void {
  if (model.loaded) return
  void (async () => {
    try {
      if (await model.isAvailable()) await model.load()
    } catch {
      // The next scan reports the failure properly if it needs the model.
    }
  })()
}

async function runConfirmation(
  text: string,
  findings: Finding[],
  ambiguous: Finding[],
  candidates: Finding[],
  declined: Array<{ start: number; end: number }>,
  model: LocalModelDetector,
): Promise<Run> {
  const started = performance.now()
  let coldStartMs: number | undefined
  const base: EscalationStats = {
    ...NO_ESCALATION,
    ambiguous: ambiguous.length,
    offered: candidates.length,
    modelId: model.id,
  }

  try {
    // An unprovisioned model must not mean *no* second opinion. Fall back to
    // the deterministic pass, which needs no files and cannot be unavailable.
    if (!(await model.isAvailable())) {
      if (model === deepContextConfirmer) {
        return {
          findings,
          stats: { ...base, ms: performance.now() - started },
          profile: EMPTY_PROFILE,
        }
      }
      console.warn(
        `[ai-safe] "${model.id}" is not provisioned — falling back to the ` +
          `${deepContextConfirmer.id} confirmer. Run \`npm run provision:model\`.`,
      )
      // Calls the inner runner rather than `confirmAmbiguous`: the lock is
      // already held by our caller, and taking it again would deadlock.
      const fallback = await runConfirmation(
        text,
        findings,
        ambiguous,
        candidates,
        declined,
        deepContextConfirmer,
      )
      return {
        findings: fallback.findings,
        stats: {
          ...fallback.stats,
          modelId: `${model.id} → ${deepContextConfirmer.id}`,
          error: `${model.id} is not provisioned`,
        },
        profile: fallback.profile,
      }
    }

    // One call, as before — `load` is documented idempotent. Timed only when
    // the model was cold, so a resident model is never billed for a start it
    // did not pay, and the cost lands on the call that actually waited.
    const wasCold = !model.loaded
    const loadStarted = performance.now()
    await model.load()
    if (wasCold) coldStartMs = performance.now() - loadStarted

    const requests = buildRequests(text, [
      ...ambiguous.map((finding) => ({ finding, unresolved: false })),
      ...candidates.map((finding) => ({ finding, unresolved: true })),
    ])

    const verdicts = await model.confirm(requests)
    const byId = new Map(verdicts.map((v) => [v.id, v]))

    let confirmed = 0
    let rejected = 0
    let unresolved = 0
    let recovered = 0
    let relabelled = 0
    const resolved: Finding[] = []

    const vouched = (finding: Finding, verdict: ConfirmationVerdict): Finding => {
      const confidence = Math.max(finding.confidence, verdict.confidence)
      // The confirmer may know better what this actually is.
      const corrected = verdict.category && verdict.category !== finding.category
      if (corrected) relabelled += 1
      return {
        ...finding,
        category: verdict.category ?? finding.category,
        confidence,
        tier: tierFor(Math.max(confidence, MEDIUM_THRESHOLD)),
        rule: corrected ? `Relabelled by the ${model.label}` : finding.rule,
        confirmedBy: model.id,
        signals: [
          ...finding.signals,
          {
            id: `confirmed:${model.id}`,
            weight: 0,
            note: verdict.note ?? `Checked again by the ${model.label}.`,
          },
        ],
      }
    }

    // --- the precision half: overturn or uphold what the rules called -----
    for (const finding of findings) {
      const verdict = byId.get(finding.id)
      if (!verdict || finding.tier !== 'medium') {
        resolved.push(finding)
        continue
      }

      if (verdict.decision === 'confirm') {
        confirmed += 1
        resolved.push(vouched(finding, verdict))
        continue
      }

      // A rejection removes the finding.
      //
      // The confirmer only answers on the categories it was trained for —
      // people, companies, places — and on those it is a model trained on far
      // more text than any hand-written rule encodes. Where the two disagree
      // about a name, it is usually the rule that is guessing from shape. It
      // is never consulted about emails, keys or identifiers, so it cannot
      // overturn those: `confirm()` returns "unknown" for anything outside its
      // competence, and unknown leaves the finding exactly as it was.
      if (verdict.decision === 'reject') {
        rejected += 1
        continue
      }

      unresolved += 1
      resolved.push({
        ...finding,
        confirmedBy: model.id,
        signals: verdict.note
          ? [...finding.signals, { id: `checked:${model.id}`, weight: 0, note: verdict.note }]
          : finding.signals,
      })
    }

    // --- the recall half: promote what the rules never called -------------
    for (const candidate of candidates) {
      const verdict = byId.get(candidate.id)
      if (verdict?.decision !== 'confirm') continue
      recovered += 1
      resolved.push(vouched(candidate, verdict))
    }

    // --- and anything the confirmer saw that we never proposed ------------
    const taken = new Uint8Array(text.length)
    for (const finding of resolved) {
      for (let i = finding.start; i < finding.end; i++) taken[i] = 1
    }
    // Block the spans the rules examined and turned down. Discovery is for
    // text nobody assessed, not a second vote on a settled one.
    for (const span of declined) {
      for (let i = span.start; i < span.end; i++) taken[i] = 1
    }

    let discovered = 0
    for (const verdict of verdicts) {
      for (const entity of verdict.discovered ?? []) {
        if (entity.start < 0 || entity.end > text.length) continue
        let overlaps = false
        for (let i = entity.start; i < entity.end; i++) {
          if (taken[i]) {
            overlaps = true
            break
          }
        }
        if (overlaps) continue
        for (let i = entity.start; i < entity.end; i++) taken[i] = 1

        discovered += 1
        resolved.push({
          id: `d${discovered}`,
          category: entity.category,
          value: entity.value,
          start: entity.start,
          end: entity.end,
          confidence: entity.confidence,
          tier: tierFor(Math.max(entity.confidence, MEDIUM_THRESHOLD)),
          layer: 'entity',
          rule: `Spotted by the ${model.label}`,
          confirmedBy: model.id,
          enabled: true,
          signals: [
            {
              id: `discovered:${model.id}`,
              weight: 0,
              note: `The word lists did not recognise this, but the ${model.label} identified it.`,
            },
          ],
        })
      }
    }

    // --- one value, one answer --------------------------------------------
    // The confirmer judges each mention on its own window, so the same word can
    // come back as a person in one sentence and a company in the next. That
    // reads as a bug to anyone looking at the output, and it is: whatever
    // "Kena" is, it is the same thing in both places. Settle every mention on
    // the reading of its most confident occurrence.
    const strongest = new Map<string, Finding>()
    for (const finding of resolved) {
      const key = finding.value.toLowerCase()
      const held = strongest.get(key)
      if (!held || finding.confidence > held.confidence) {
        strongest.set(key, finding)
      }
    }

    const consistent = resolved.map((finding) => {
      const best = strongest.get(finding.value.toLowerCase())
      if (!best || best === finding || best.category === finding.category) {
        return finding
      }
      return {
        ...finding,
        category: best.category,
        confidence: Math.max(finding.confidence, best.confidence),
        tier: best.tier,
        signals: [
          ...finding.signals,
          {
            id: 'consistent-category',
            weight: 0,
            note: `Matched to the same value elsewhere in this content.`,
          },
        ],
      }
    })

    return {
      findings: consistent.sort((a, b) => a.start - b.start),
      stats: {
        ...base,
        modelAvailable: true,
        modelInvoked: true,
        modelLoaded: model.loaded,
        confirmed,
        rejected,
        unresolved,
        recovered,
        discovered,
        relabelled,
        ms: performance.now() - started,
      },
      profile: {
        batchSize: requests.length,
        windowCount: new Set(requests.map((r) => r.window)).size,
        windowChars: requests.reduce((n, r) => Math.max(n, r.window.length), 0),
        coldStartMs,
      },
    }
  } catch (cause) {
    // Degrade safely — the user still gets the fast-path findings. But say so
    // loudly in the console: a confirmer that silently stops running looks
    // exactly like one that is working, and the findings quietly get worse.
    console.warn(
      `[ai-safe] The "${model.id}" confirmer failed, so this scan used the fast path only.`,
      cause,
    )
    return {
      findings,
      stats: {
        ...base,
        modelAvailable: true,
        modelInvoked: true,
        ms: performance.now() - started,
        error: cause instanceof Error ? cause.message : 'confirmation failed',
      },
      profile: { ...EMPTY_PROFILE, coldStartMs },
    }
  }
}
