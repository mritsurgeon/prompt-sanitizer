import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FAILURE_THRESHOLD,
  budgetFor,
  isCircuitOpen,
  registerLocalModel,
  resetGuard,
  resetLocalModel,
  resetScheduler,
  type LocalModelDetector,
} from '../confirm'
import { scanWithConfirmation } from '../detect'
import {
  applyRetention,
  charBucket,
  memorySink,
  percentile,
  registerMetricsSink,
  resetMetricsSink,
  summarise,
  type PerformanceEnvelope,
} from '../metrics'

/**
 * The metrics seam.
 *
 * Two things are being defended here. The obvious one is that the numbers are
 * right. The less obvious one — and the reason this file exists at all — is
 * that instrumentation must not be able to change the behaviour of the thing
 * it instruments: not by throwing, not by blocking, and not by recording an
 * escalation that never happened.
 */

const AMBIGUOUS = 'Adeyemi confirmed the migration window this morning.'
const UNAMBIGUOUS = 'Email sarah.mitchell@example.com about CASE-49281.'

function model(
  overrides: Partial<LocalModelDetector> = {},
): LocalModelDetector {
  let loaded = false
  return {
    id: 'test-model',
    label: 'Test model',
    cost: { bytes: 1_000_000, startupMs: null, perCandidateMs: null },
    runtime: { ep: 'wasm-threaded', labelCount: 2, tokenCountBucket: 128 },
    get loaded() {
      return loaded
    },
    isAvailable: async () => true,
    load: async () => {
      loaded = true
    },
    confirm: async (requests) =>
      requests.map((r) => ({ id: r.id, decision: 'confirm', confidence: 0.95 })),
    ...overrides,
  }
}

afterEach(() => {
  resetLocalModel()
  resetMetricsSink()
  resetScheduler()
  resetGuard()
})

describe('the envelope carries no content', () => {
  it('emits counts and context, and no text from the document', async () => {
    const sink = memorySink()
    registerMetricsSink(sink)
    registerLocalModel(model())

    // 'banner' rather than 'submit-gate': a held send declines to pay a cold
    // start, which is its own behaviour and is covered below.
    await scanWithConfirmation(AMBIGUOUS, { phase: 'banner' })

    expect(sink.events).toHaveLength(1)
    const event = sink.events[0]

    expect(event.phase).toBe('banner')
    expect(event.confirmerId).toBe('test-model')
    expect(event.ep).toBe('wasm-threaded')
    expect(event.labelCount).toBe(2)
    expect(event.batchSize).toBeGreaterThan(0)
    expect(event.candidatesEvaluated).toBe(event.batchSize)
    expect(event.durationMs).toBeGreaterThanOrEqual(0)

    // The actual guarantee, asserted two ways.
    //
    // First: no *value* holds any of the input. Serialising the whole object
    // would match field names instead of content (`windowCharsBucket` contains
    // "window"), which is exactly the kind of test that passes for the wrong
    // reason — so only the values are searched.
    const values = JSON.stringify(Object.values(event))
    for (const word of AMBIGUOUS.split(/\s+/)) {
      expect(values).not.toContain(word)
    }

    // Second, and stronger: the only string-typed fields are the ones that
    // structurally cannot hold content. A future field that could would fail
    // here rather than being caught by a word list.
    const stringFields = Object.entries(event)
      .filter(([, value]) => typeof value === 'string')
      .map(([key]) => key)
      .sort()
    expect(stringFields).toEqual(['confirmerId', 'ep', 'phase', 'traceId'])
  })

  it('buckets the window size rather than reporting a length', async () => {
    const sink = memorySink()
    registerMetricsSink(sink)
    registerLocalModel(model())

    await scanWithConfirmation(AMBIGUOUS, { phase: 'harness' })

    // A precise character count is a fingerprint of a specific document.
    expect([128, 256, 512, 1024, 2048, 4096]).toContain(
      sink.events[0].windowCharsBucket,
    )
  })

  it('floors the timestamp to the minute', async () => {
    const sink = memorySink()
    registerMetricsSink(sink)
    registerLocalModel(model())

    await scanWithConfirmation(AMBIGUOUS, { phase: 'harness' })

    expect(sink.events[0].timestamp % 60_000).toBe(0)
  })

  it('attributes a cold start to the call that paid for it', async () => {
    const sink = memorySink()
    registerMetricsSink(sink)
    const shared = model()
    registerLocalModel(shared)

    await scanWithConfirmation(AMBIGUOUS, { phase: 'harness' })
    await scanWithConfirmation(AMBIGUOUS, { phase: 'harness' })

    expect(sink.events[0].coldStart).toBe(true)
    expect(sink.events[0].coldStartMs).toBeGreaterThanOrEqual(0)
    // Second call reuses the resident model, so it must not be billed again.
    expect(sink.events[1].coldStart).toBe(false)
    expect(sink.events[1].coldStartMs).toBeUndefined()
  })

  it('records a relabel, which the stats used to compute and discard', async () => {
    const sink = memorySink()
    registerMetricsSink(sink)
    registerLocalModel(
      model({
        confirm: async (requests) =>
          requests.map((r) => ({
            id: r.id,
            decision: 'confirm' as const,
            confidence: 0.95,
            category: 'ORGANISATION' as const,
          })),
      }),
    )

    const result = await scanWithConfirmation(AMBIGUOUS, { phase: 'harness' })

    expect(result.escalation.relabelled).toBeGreaterThan(0)
    expect(sink.events[0].relabelled).toBe(result.escalation.relabelled)
  })
})

describe('an escalation that never happened is not a data point', () => {
  it('emits nothing when the gate declines to escalate', async () => {
    const sink = memorySink()
    registerMetricsSink(sink)
    registerLocalModel(model())

    const result = await scanWithConfirmation(UNAMBIGUOUS, { phase: 'harness' })

    expect(result.escalation.modelInvoked).toBe(false)
    // Recording a zero here would put "escalations that cost nothing" into the
    // same percentile as ones that ran a model, and the p50 would be a lie.
    expect(sink.events).toHaveLength(0)
  })
})

describe('instrumentation cannot break the scan', () => {
  it('survives a sink that throws on every call', async () => {
    registerMetricsSink({
      record: () => {
        throw new Error('sink is on fire')
      },
    })
    registerLocalModel(model())

    const result = await scanWithConfirmation(AMBIGUOUS, { phase: 'harness' })

    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.escalation.error).toBeUndefined()
  })
})

describe('the epoch guard', () => {
  it('discards the older of two overlapping escalations', async () => {
    const sink = memorySink()
    registerMetricsSink(sink)

    let inflight = 0
    let overlapped = false
    registerLocalModel(
      model({
        confirm: async (requests) => {
          inflight += 1
          if (inflight > 1) overlapped = true
          await new Promise((r) => setTimeout(r, 20))
          inflight -= 1
          return requests.map((r) => ({
            id: r.id,
            decision: 'confirm' as const,
            confidence: 0.95,
          }))
        },
      }),
    )

    const [first, second] = await Promise.all([
      scanWithConfirmation(AMBIGUOUS, { phase: 'harness' }),
      scanWithConfirmation(AMBIGUOUS, { phase: 'harness' }),
    ])

    // Only one batch at a time: the lock, not just the epoch.
    expect(overlapped).toBe(false)
    // The older one is abandoned rather than applied to text that has moved on.
    expect(first.escalation.superseded).toBe(true)
    expect(second.escalation.superseded).toBe(false)
    // A superseded escalation still returns usable fast-path findings.
    expect(first.findings.length).toBeGreaterThan(0)
    expect(sink.events.filter((e) => e.superseded)).toHaveLength(1)
  })

  it('does not let a superseded escalation run inference at all', async () => {
    let confirmCalls = 0
    registerLocalModel(
      model({
        confirm: async (requests) => {
          confirmCalls += 1
          await new Promise((r) => setTimeout(r, 20))
          return requests.map((r) => ({
            id: r.id,
            decision: 'confirm' as const,
            confidence: 0.95,
          }))
        },
      }),
    )

    await Promise.all([
      scanWithConfirmation(AMBIGUOUS, { phase: 'harness' }),
      scanWithConfirmation(AMBIGUOUS, { phase: 'harness' }),
      scanWithConfirmation(AMBIGUOUS, { phase: 'harness' }),
    ])

    // Three requests, one survivor — the queued ones skip the model entirely
    // rather than computing an answer nobody will read.
    expect(confirmCalls).toBe(1)
  })

  it('a throwing confirmer does not wedge the queue', async () => {
    registerLocalModel(
      model({
        confirm: async () => {
          throw new Error('inference exploded')
        },
      }),
    )

    const first = await scanWithConfirmation(AMBIGUOUS, { phase: 'harness' })
    expect(first.escalation.error).toContain('inference exploded')

    // The lock is chained on both settle paths, so the next escalation runs.
    registerLocalModel(model())
    const second = await scanWithConfirmation(AMBIGUOUS, { phase: 'harness' })
    expect(second.escalation.modelInvoked).toBe(true)
    expect(second.escalation.superseded).toBe(false)
  })
})

describe('summarising', () => {
  const event = (over: Partial<PerformanceEnvelope> = {}): PerformanceEnvelope => ({
    traceId: Math.random().toString(36).slice(2),
    timestamp: Date.now(),
    phase: 'submit-gate',
    confirmerId: 'gliner',
    ep: 'wasm-threaded',
    coldStart: false,
    durationMs: 10,
    superseded: false,
    timedOut: false,
    circuitBreakerTripped: false,
    coldDeclined: false,
    cacheHit: false,
    escalated: true,
    batchSize: 1,
    windowCount: 1,
    windowCharsBucket: 512,
    ambiguous: 1,
    offered: 0,
    candidatesEvaluated: 1,
    confirmed: 1,
    rejected: 0,
    unresolved: 0,
    recovered: 0,
    discovered: 0,
    relabelled: 0,
    ...over,
  })

  it('uses nearest-rank percentiles', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(values, 50)).toBe(5)
    expect(percentile(values, 95)).toBe(10)
    expect(percentile(values, 100)).toBe(10)
    // The naive `sorted[floor(n * p / 100)]` returns undefined here.
    expect(percentile([42], 95)).toBe(42)
    expect(percentile([], 50)).toBe(0)
  })

  it('keeps non-inference latencies out of the duration percentiles', () => {
    const summary = summarise([
      event({ durationMs: 100 }),
      event({ durationMs: 1, superseded: true, escalated: false }),
      event({ durationMs: 1, cacheHit: true }),
      event({ durationMs: 1, error: 'boom' }),
    ])

    expect(summary.events).toBe(4)
    // A superseded, cached or failed call did not run a model, so its duration
    // is not an inference latency and must not flatter the p50.
    expect(summary.inferences).toBe(1)
    expect(summary.p50DurationMs).toBe(100)
    expect(summary.cacheHitRatio).toBeCloseTo(0.25)
    expect(summary.supersededRate).toBeCloseTo(0.25)
    expect(summary.errorRate).toBeCloseTo(0.25)
  })

  it('never mixes surfaces, because their budgets differ by 10x', () => {
    const events = [
      event({ phase: 'submit-gate', durationMs: 50 }),
      event({ phase: 'banner', durationMs: 2000 }),
    ]

    expect(summarise(events, { phase: 'submit-gate' }).p95DurationMs).toBe(50)
    expect(summarise(events, { phase: 'banner' }).p95DurationMs).toBe(2000)
    expect(summarise(events).phase).toBe('all')
  })

  it('counts execution providers so "is WebGPU helping" is answerable', () => {
    const summary = summarise([
      event({ ep: 'webgpu', durationMs: 20 }),
      event({ ep: 'webgpu', durationMs: 25 }),
      event({ ep: 'wasm-single', durationMs: 300 }),
    ])

    expect(summary.epDistribution.webgpu).toBe(2)
    expect(summary.epDistribution['wasm-single']).toBe(1)
    expect(summary.epDistribution['wasm-threaded']).toBe(0)
  })

  it('excludes events outside the window', () => {
    const summary = summarise(
      [event({ timestamp: Date.now() - 10_000 }), event({ timestamp: 0 })],
      { sinceMs: 60_000 },
    )
    expect(summary.events).toBe(1)
  })

  it('reports a cold-start median only when one was paid', () => {
    expect(summarise([event()]).p50ColdStartMs).toBeNull()
    expect(
      summarise([event({ coldStart: true, coldStartMs: 900 })]).p50ColdStartMs,
    ).toBe(900)
  })
})

describe('retention is bounded by age and by count', () => {
  const at = (timestamp: number): PerformanceEnvelope =>
    ({ timestamp }) as PerformanceEnvelope

  it('drops events past the age limit', () => {
    const now = 1_000_000_000
    const kept = applyRetention(
      [at(now), at(now - 1000), at(now - 999_000)],
      { maxEvents: 100, maxAgeMs: 10_000 },
      now,
    )
    expect(kept).toHaveLength(2)
  })

  it('drops the oldest past the count limit', () => {
    const now = 1_000_000_000
    const kept = applyRetention(
      [at(now - 3), at(now - 1), at(now - 2)],
      { maxEvents: 2, maxAgeMs: 10_000 },
      now,
    )
    // Either limit alone fails: age lets a busy hour fill the disk, count lets
    // a quiet month keep records past the promised window.
    expect(kept.map((e) => e.timestamp)).toEqual([now - 1, now - 2])
  })
})

describe('char bucketing', () => {
  it('rounds up and saturates', () => {
    expect(charBucket(1)).toBe(128)
    expect(charBucket(128)).toBe(128)
    expect(charBucket(129)).toBe(256)
    expect(charBucket(999_999)).toBe(4096)
  })
})

describe('the execution guard', () => {
  /** A confirmer that hangs for `ms`, to overrun a budget on purpose. */
  const slow = (ms: number) =>
    model({
      confirm: async (requests) => {
        await new Promise((r) => setTimeout(r, ms))
        return requests.map((r) => ({
          id: r.id,
          decision: 'confirm' as const,
          confidence: 0.95,
        }))
      },
    })

  it('declines a cold start on a held send, and warms in the background', async () => {
    const sink = memorySink()
    registerMetricsSink(sink)
    const cold = model()
    registerLocalModel(cold)

    const result = await scanWithConfirmation(AMBIGUOUS, {
      phase: 'submit-gate',
    })

    // Loading weights to answer a keystroke somebody is waiting on is the
    // wrong trade — the same reasoning the gate already applies to recovery
    // candidates.
    expect(result.escalation.coldDeclined).toBe(true)
    expect(result.escalation.modelInvoked).toBe(false)
    expect(result.findings.length).toBeGreaterThan(0)
    expect(sink.events[0].coldDeclined).toBe(true)
    expect(sink.events[0].escalated).toBe(false)

    // But the load was started, so the next send is warm and does escalate.
    await vi.waitFor(() => expect(cold.loaded).toBe(true))
    const second = await scanWithConfirmation(AMBIGUOUS, {
      phase: 'submit-gate',
    })
    expect(second.escalation.modelInvoked).toBe(true)
  })

  it('keeps the fast path when a warm escalation overruns its budget', async () => {
    const sink = memorySink()
    registerMetricsSink(sink)
    const confirmer = slow(400)
    registerLocalModel(confirmer)
    await confirmer.load() // warm, so the 150 ms held-send budget applies

    const started = performance.now()
    const result = await scanWithConfirmation(AMBIGUOUS, {
      phase: 'submit-gate',
    })
    const waited = performance.now() - started

    expect(result.escalation.timedOut).toBe(true)
    expect(result.findings.length).toBeGreaterThan(0)
    // Answered on the budget, not when the abandoned inference finished.
    expect(waited).toBeLessThan(350)
    expect(sink.events[0].timedOut).toBe(true)
    expect(sink.events[0].escalated).toBe(false)
  })

  it('holds the lock past a timeout, so the next inference cannot overlap', async () => {
    let inflight = 0
    let overlapped = false
    const confirmer = model({
      confirm: async (requests) => {
        inflight += 1
        if (inflight > 1) overlapped = true
        await new Promise((r) => setTimeout(r, 300))
        inflight -= 1
        return requests.map((r) => ({
          id: r.id,
          decision: 'confirm' as const,
          confidence: 0.95,
        }))
      },
    })
    registerLocalModel(confirmer)
    await confirmer.load()

    // First overruns the 150 ms budget and is abandoned — but it is still
    // running, because ORT cannot cancel.
    const first = await scanWithConfirmation(AMBIGUOUS, {
      phase: 'submit-gate',
    })
    expect(first.escalation.timedOut).toBe(true)

    // Second starts immediately. If the lock had been released on timeout it
    // would run concurrently with the abandoned one, and two inferences would
    // be fighting over the same WASM memory.
    const second = await scanWithConfirmation(AMBIGUOUS, { phase: 'harness' })
    expect(overlapped).toBe(false)
    expect(second.escalation.modelInvoked).toBe(true)
  })

  it('trips the breaker after repeated warm timeouts, then stops trying', async () => {
    const sink = memorySink()
    registerMetricsSink(sink)
    const confirmer = slow(400)
    registerLocalModel(confirmer)
    await confirmer.load()

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      resetScheduler() // each attempt is its own, not a supersession
      await scanWithConfirmation(AMBIGUOUS, { phase: 'submit-gate' })
    }
    expect(isCircuitOpen()).toBe(true)

    const after = await scanWithConfirmation(AMBIGUOUS, { phase: 'submit-gate' })
    expect(after.escalation.circuitOpen).toBe(true)
    expect(after.escalation.timedOut).toBe(false)
    // Predictably deterministic beats intermittently slow: once the machine
    // has shown it cannot meet the budget, stop paying it on every scan.
    expect(sink.events.at(-1)?.circuitBreakerTripped).toBe(true)
    expect(after.findings.length).toBeGreaterThan(0)
  })

  it('does not count supersession toward the breaker', async () => {
    registerLocalModel(slow(30))

    // Three quick edits in a row. If supersession counted as failure, typing
    // fast would disable the model for the session.
    await Promise.all([
      scanWithConfirmation(AMBIGUOUS, { phase: 'harness' }),
      scanWithConfirmation(AMBIGUOUS, { phase: 'harness' }),
      scanWithConfirmation(AMBIGUOUS, { phase: 'harness' }),
      scanWithConfirmation(AMBIGUOUS, { phase: 'harness' }),
    ])

    expect(isCircuitOpen()).toBe(false)
  })

  it('does not count a cold-start overrun toward the breaker', async () => {
    registerLocalModel(
      model({
        load: async () => {
          await new Promise((r) => setTimeout(r, 200))
        },
      }),
    )

    // 'overlay' is willing to attempt cold, but a 200 ms load against a
    // deliberately tiny budget overruns. That must not be a fault: the load
    // is still running and warms the model for the next call, so counting it
    // would trip the breaker on every fresh session, permanently.
    for (let i = 0; i < FAILURE_THRESHOLD + 1; i++) {
      resetScheduler()
      await scanWithConfirmation(AMBIGUOUS, { phase: 'overlay' })
    }
    expect(isCircuitOpen()).toBe(false)
  })

  it('resets the failure count on a success', async () => {
    const failing = slow(400)
    registerLocalModel(failing)
    await failing.load()

    resetScheduler()
    await scanWithConfirmation(AMBIGUOUS, { phase: 'submit-gate' })
    resetScheduler()
    await scanWithConfirmation(AMBIGUOUS, { phase: 'submit-gate' })

    registerLocalModel(model())
    resetScheduler()
    const good = await scanWithConfirmation(AMBIGUOUS, { phase: 'banner' })
    expect(good.escalation.modelInvoked).toBe(true)

    // Two failures then a success: the next two failures must not trip it.
    registerLocalModel(failing)
    resetScheduler()
    await scanWithConfirmation(AMBIGUOUS, { phase: 'submit-gate' })
    resetScheduler()
    await scanWithConfirmation(AMBIGUOUS, { phase: 'submit-gate' })
    expect(isCircuitOpen()).toBe(false)
  })

  it('budgets a held send far tighter than a background pass', () => {
    // The reason `phase` exists: one number would either strangle the
    // background path or hang the foreground one.
    expect(budgetFor('submit-gate', false).ms).toBeLessThan(
      budgetFor('banner', false).ms,
    )
    expect(budgetFor('submit-gate', true).attemptWhenCold).toBe(false)
    expect(budgetFor('banner', true).attemptWhenCold).toBe(true)
    expect(budgetFor('banner', true).ms).toBeGreaterThan(
      budgetFor('banner', false).ms,
    )
  })
})
