import type {
  CharBucket,
  ExecutionProvider,
  MetricsPhase,
  MetricsSummary,
  PerformanceEnvelope,
  SummaryQuery,
} from './types'

/**
 * Pure reduction from events to a summary.
 *
 * Kept separate from any store so it can be tested in Node without a browser,
 * and so the local store and a future fleet collector cannot disagree about
 * what "p95" means.
 */

const EPS: ExecutionProvider[] = ['webgpu', 'wasm-threaded', 'wasm-single', 'none']

const CHAR_BUCKETS: CharBucket[] = [128, 256, 512, 1024, 2048, 4096]

/** Round a length up to a bucket, so a size can never identify a document. */
export function charBucket(chars: number): CharBucket {
  for (const bucket of CHAR_BUCKETS) if (chars <= bucket) return bucket
  return 4096
}

/**
 * Nearest-rank percentile.
 *
 * `p` is 0..100. Written out rather than borrowed because the obvious
 * `sorted[Math.floor(n * p / 100)]` is off by one at the top of the range and
 * silently returns the wrong element for small samples — which is every sample
 * on a fresh install.
 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

const ratio = (n: number, total: number) => (total ? n / total : 0)

export function summarise(
  all: PerformanceEnvelope[],
  query: SummaryQuery = {},
): MetricsSummary {
  const sinceMs = query.sinceMs ?? 24 * 60 * 60 * 1000
  const to = Date.now()
  const from = to - sinceMs

  const events = all.filter(
    (e) => e.timestamp >= from && (!query.phase || e.phase === query.phase),
  )

  const epDistribution = Object.fromEntries(
    EPS.map((ep) => [ep, 0]),
  ) as Record<ExecutionProvider, number>
  const confirmerDistribution: Record<string, number> = {}

  // An escalation that was superseded, declined, cached or errored never ran
  // the confirmer, so its duration is not an inference latency and must not
  // land in the same percentile as one that did.
  const inferenceDurations: number[] = []
  const coldStartMs: number[] = []
  let inferences = 0
  let cacheHits = 0
  let timeouts = 0
  let superseded = 0
  let coldDeclined = 0
  let circuitOpen = 0
  let errors = 0
  let coldStarts = 0

  for (const e of events) {
    epDistribution[e.ep] = (epDistribution[e.ep] ?? 0) + 1
    confirmerDistribution[e.confirmerId] =
      (confirmerDistribution[e.confirmerId] ?? 0) + 1

    if (e.cacheHit) cacheHits += 1
    if (e.timedOut) timeouts += 1
    if (e.superseded) superseded += 1
    if (e.coldDeclined) coldDeclined += 1
    if (e.circuitBreakerTripped) circuitOpen += 1
    if (e.error) errors += 1
    if (e.coldStart) coldStarts += 1
    if (typeof e.coldStartMs === 'number') coldStartMs.push(e.coldStartMs)

    // `escalated` rather than "none of the failure flags are set": the fact
    // is reported by the coordinator, which knows, instead of inferred here
    // from a list that goes stale the moment a new flag is added.
    if (e.escalated && !e.cacheHit && !e.error) {
      inferences += 1
      inferenceDurations.push(e.durationMs)
    }
  }

  return {
    events: events.length,
    inferences,
    cacheHitRatio: ratio(cacheHits, events.length),
    p50DurationMs: percentile(inferenceDurations, 50),
    p95DurationMs: percentile(inferenceDurations, 95),
    p99DurationMs: percentile(inferenceDurations, 99),
    timeoutRate: ratio(timeouts, events.length),
    supersededRate: ratio(superseded, events.length),
    coldDeclinedRate: ratio(coldDeclined, events.length),
    circuitOpenCount: circuitOpen,
    errorRate: ratio(errors, events.length),
    coldStarts,
    p50ColdStartMs: coldStartMs.length ? percentile(coldStartMs, 50) : null,
    epDistribution,
    confirmerDistribution,
    phase: query.phase ?? ('all' satisfies MetricsPhase | 'all'),
    from,
    to,
  }
}

/**
 * Retention, applied at the store rather than left to grow.
 *
 * Two limits because either alone fails: an age limit lets a busy hour fill
 * the disk, and a count limit lets a quiet month keep records long past the
 * window the product promises.
 */
export interface RetentionLimits {
  maxEvents: number
  maxAgeMs: number
}

export const DEFAULT_RETENTION: RetentionLimits = {
  maxEvents: 5000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
}

/** Returns the events to keep, newest first order preserved by timestamp. */
export function applyRetention(
  events: PerformanceEnvelope[],
  limits: RetentionLimits = DEFAULT_RETENTION,
  now: number = Date.now(),
): PerformanceEnvelope[] {
  const cutoff = now - limits.maxAgeMs
  return events
    .filter((e) => e.timestamp >= cutoff)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limits.maxEvents)
}
