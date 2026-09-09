/**
 * The performance envelope.
 *
 * One record per escalation, describing what the second stage cost and what it
 * decided — and containing no prompt text, no matched value and no window.
 * That is not a promise about how the fields are used; there is no field here
 * a value could be put in. The same shape is emitted by the app, by the
 * extension and by the Node benchmark scripts, so a number measured in one is
 * comparable with the same number measured in another.
 *
 * Types only, and the write seam. The engine depends on `MetricsSink` and
 * nothing else — it cannot see storage, cannot query, and cannot await I/O.
 */

/** Which execution provider actually ran, as reported by the confirmer. */
export type ExecutionProvider =
  | 'webgpu'
  | 'wasm-threaded'
  | 'wasm-single'
  /** No tensor runtime involved — a code-only confirmer answered. */
  | 'none'

/**
 * Which surface paid for this escalation. Supplied by the caller, because the
 * engine has no idea whether a person is waiting on it.
 *
 * The budgets differ by an order of magnitude between these, so a p95 that
 * mixes them is meaningless.
 */
export type MetricsPhase =
  /** Extension: the send is held and the user is waiting. Tightest budget. */
  | 'submit-gate'
  /** Extension: a banner is already on screen, so nobody is waiting. */
  | 'banner'
  /** Web app: the scan overlay is up and being watched. */
  | 'overlay'
  /** Web app: a file was dropped and is being read. */
  | 'file'
  /** A benchmark or test harness. Excluded from user-facing summaries. */
  | 'harness'
  | 'unknown'

/** Window sizes are bucketed so a length can never fingerprint a document. */
export type CharBucket = 128 | 256 | 512 | 1024 | 2048 | 4096

export interface PerformanceEnvelope {
  /** Correlates this record with nothing else; unique per escalation. */
  traceId: string
  /** Epoch ms, floored to the minute — a precise clock re-identifies. */
  timestamp: number
  phase: MetricsPhase

  // --- execution context ---------------------------------------------------
  /** Confirmer identity, e.g. `gliner-small-v2.1` or `deep-context`. */
  confirmerId: string
  /** Execution provider, separate from confirmer identity on purpose: a
   *  deterministic confirmer is not an "execution provider", and conflating
   *  the two makes it impossible to ask "is WebGPU helping". */
  ep: ExecutionProvider
  /** The confirmer was not resident when this escalation began. */
  coldStart: boolean
  /** Load cost, present only when this call paid it. */
  coldStartMs?: number
  /** Wall clock for the whole escalation, load included. */
  durationMs: number

  // --- gate accounting -----------------------------------------------------
  /** The escalation was abandoned because a newer one replaced it. */
  superseded: boolean
  /** A latency budget expired and the fast path was kept. */
  timedOut: boolean
  /** Repeated failures disabled escalation for the rest of the session. */
  circuitBreakerTripped: boolean
  /**
   * The confirmer was cold and this surface's budget forbids paying a cold
   * start — a held send, in practice. The load was started in the background.
   */
  coldDeclined: boolean
  /** Answered from the window cache without running the confirmer. */
  cacheHit: boolean
  /**
   * The confirmer actually ran. The duration percentiles are taken over these
   * only: a superseded, declined, cached or failed escalation did not run a
   * model, and averaging its near-zero cost with a real inference produces a
   * p50 that describes nothing.
   */
  escalated: boolean

  // --- input profile -------------------------------------------------------
  /** Candidates adjudicated in one call. */
  batchSize: number
  /**
   * Distinct windows submitted. The dominant term in inference cost — an
   * eight-window call costs roughly eight times a one-window call, while
   * dropping a label costs single-digit percent — so this is the number to
   * watch when tuning.
   */
  windowCount: number
  /** Largest window in the batch, bucketed. */
  windowCharsBucket: CharBucket
  /** Present once the confirmer tokenizes; the engine counts characters. */
  tokenCountBucket?: 64 | 128 | 256 | 512
  /** Labels passed to the model — the confusion-set optimisation moves this
   *  from ~10 to 2, so it has to be visible before and after. */
  labelCount?: number

  // --- outcome accounting (counts only) ------------------------------------
  /** Findings the rules could not stand behind. */
  ambiguous: number
  /** Low-confidence unknowns offered for recovery. */
  offered: number
  /** Windows the confirmer was actually asked about. */
  candidatesEvaluated: number
  confirmed: number
  rejected: number
  unresolved: number
  recovered: number
  discovered: number
  /** Kept its finding but corrected the category. */
  relabelled: number

  /** Set when the confirmer failed and the fast path was kept. */
  error?: string
}

/**
 * The write seam — the only metrics type the engine imports.
 *
 * `record` is synchronous and must never throw. Both properties are load
 * bearing: an awaited write would add storage latency to the measurement it is
 * taking, and a throwing sink would turn instrumentation into an outage on the
 * path that holds somebody's keystroke. Implementations buffer and flush on
 * their own schedule.
 */
export interface MetricsSink {
  record(event: PerformanceEnvelope): void
}

export interface MetricsSummary {
  events: number
  /** Escalations where the confirmer actually ran. */
  inferences: number
  cacheHitRatio: number
  p50DurationMs: number
  p95DurationMs: number
  p99DurationMs: number
  timeoutRate: number
  supersededRate: number
  coldDeclinedRate: number
  /** Escalations skipped because the breaker had already tripped. */
  circuitOpenCount: number
  errorRate: number
  coldStarts: number
  /** Null when no call has paid a cold start in the window. */
  p50ColdStartMs: number | null
  epDistribution: Record<ExecutionProvider, number>
  confirmerDistribution: Record<string, number>
  /** Windowed so a summary is never a mix of incomparable budgets. */
  phase: MetricsPhase | 'all'
  from: number
  to: number
}

export interface SummaryQuery {
  /** How far back to look. Defaults to 24 hours. */
  sinceMs?: number
  /** Restrict to one surface. Budgets differ, so mixing them misleads. */
  phase?: MetricsPhase
}

/**
 * The read seam — what the console talks to. Implemented by the local store
 * now and, in a later phase, by a fleet collector behind the same interface.
 */
export interface MetricsSource extends MetricsSink {
  readonly id: 'local' | 'fleet' | 'demo' | 'memory'
  querySummary(query?: SummaryQuery): Promise<MetricsSummary>
  queryEvents(query?: SummaryQuery): Promise<PerformanceEnvelope[]>
  flush(): Promise<void>
  clear(): Promise<void>
}
