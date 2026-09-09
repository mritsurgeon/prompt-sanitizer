import type { MetricsSink, PerformanceEnvelope } from './types'

export type {
  CharBucket,
  ExecutionProvider,
  MetricsPhase,
  MetricsSink,
  MetricsSource,
  MetricsSummary,
  PerformanceEnvelope,
  SummaryQuery,
} from './types'

export {
  applyRetention,
  charBucket,
  DEFAULT_RETENTION,
  percentile,
  summarise,
  type RetentionLimits,
} from './summarise'

/**
 * Registry for the metrics sink, in the same shape as the confirmer registry
 * next door: exactly one is active, the default does nothing, and a real
 * implementation is registered at startup without any engine file changing.
 *
 * The default has to be a no-op rather than a store, because the engine runs
 * unchanged in Node scripts and in tests where there is no IndexedDB and
 * nobody wants a database side effect from calling `scan()`.
 */

const nullSink: MetricsSink = { record: () => {} }

let active: MetricsSink = nullSink

export function registerMetricsSink(sink: MetricsSink): void {
  active = sink
}

export function resetMetricsSink(): void {
  active = nullSink
}

/**
 * Emit an envelope. Never throws — a broken sink must not become an outage on
 * a path that is holding somebody's keystroke.
 */
export function emit(event: PerformanceEnvelope): void {
  try {
    active.record(event)
  } catch (cause) {
    // Deliberately quiet after the first one: a sink that throws will throw on
    // every scan, and a warning per keystroke is worse than the lost metric.
    if (!warned) {
      warned = true
      console.warn('[ai-safe] the metrics sink threw; metrics are off.', cause)
    }
  }
}

let warned = false

/** An in-memory sink, for tests and for the Node benchmark scripts. */
export function memorySink(): MetricsSink & { events: PerformanceEnvelope[] } {
  const events: PerformanceEnvelope[] = []
  return { events, record: (event) => void events.push(event) }
}
