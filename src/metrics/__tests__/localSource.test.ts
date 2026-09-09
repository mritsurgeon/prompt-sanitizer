import { describe, expect, it, vi } from 'vitest'
import type { PerformanceEnvelope } from '@/engine/metrics'
import { LocalSource } from '../localSource'

/**
 * The local store's survivability contract.
 *
 * These cases run with **no IndexedDB at all**, which is the point: a private
 * window, cleared site data, a browser configured to block storage and the
 * Node benchmark scripts all reach this path, and in every one of them the
 * store has to keep answering rather than throw into a scan.
 *
 * The IndexedDB plumbing itself is not covered here — it needs a fake
 * implementation (`fake-indexeddb`) that the project does not currently carry.
 * The logic worth testing was deliberately kept out of the plumbing instead:
 * `summarise` and `applyRetention` are pure and covered in
 * `src/engine/__tests__/metrics.test.ts`.
 */

const event = (over: Partial<PerformanceEnvelope> = {}): PerformanceEnvelope =>
  ({
    traceId: Math.random().toString(36).slice(2),
    timestamp: Date.now(),
    phase: 'submit-gate',
    confirmerId: 'gliner',
    ep: 'wasm-threaded',
    coldStart: false,
    durationMs: 12,
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
  }) as PerformanceEnvelope

/** No storage available — the private-window / Node case. */
const memoryOnly = () => new LocalSource({ factory: null })

describe('recording never throws and never blocks', () => {
  it('accepts events synchronously with no storage present', () => {
    const source = memoryOnly()
    expect(() => source.record(event())).not.toThrow()
    // Synchronous by contract: an awaited write would add storage latency to
    // the measurement it is taking.
    expect(source.record(event())).toBeUndefined()
  })

  it('serves buffered events before anything has been flushed', async () => {
    const source = memoryOnly()
    source.record(event({ durationMs: 40 }))
    source.record(event({ durationMs: 60 }))

    // A freshly recorded event must be visible immediately, or the console
    // reads "no activity" on a machine that is actively being protected.
    const events = await source.queryEvents()
    expect(events).toHaveLength(2)

    const summary = await source.querySummary()
    expect(summary.events).toBe(2)
    expect(summary.p50DurationMs).toBe(40)
  })

  it('filters by surface and by window', async () => {
    const source = memoryOnly()
    source.record(event({ phase: 'submit-gate' }))
    source.record(event({ phase: 'banner' }))
    source.record(event({ phase: 'banner', timestamp: 0 }))

    expect(await source.queryEvents({ phase: 'banner' })).toHaveLength(1)
    expect(await source.queryEvents({ phase: 'submit-gate' })).toHaveLength(1)
    expect(await source.queryEvents({ sinceMs: 60_000 })).toHaveLength(2)
  })

  it('warns once, not once per scan', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = memoryOnly()

    for (let i = 0; i < 40; i++) source.record(event())
    await source.flush()
    await source.flush()

    // A warning per keystroke is worse than the lost metric.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1)
    warn.mockRestore()
  })

  it('bounds the buffer when flushing cannot succeed', async () => {
    const source = new LocalSource({
      factory: null,
      retention: { maxEvents: 10, maxAgeMs: 60_000 },
    })

    for (let i = 0; i < 200; i++) source.record(event())
    await source.flush()

    // A store that can never persist must not become unbounded memory growth
    // in a tab left open all day.
    expect((await source.queryEvents()).length).toBeLessThanOrEqual(10)
  })

  it('drops buffered events older than the retention window on flush', async () => {
    const source = new LocalSource({
      factory: null,
      retention: { maxEvents: 100, maxAgeMs: 1000 },
    })

    source.record(event({ timestamp: Date.now() - 10_000 }))
    source.record(event())
    await source.flush()

    expect(await source.queryEvents({ sinceMs: 86_400_000 })).toHaveLength(1)
  })

  it('clears without a store', async () => {
    const source = memoryOnly()
    source.record(event())
    await source.clear()
    expect(await source.queryEvents()).toHaveLength(0)
  })

  it('reports its identity to the console layer', () => {
    expect(memoryOnly().id).toBe('local')
  })
})

describe('a broken factory is survivable', () => {
  it('degrades when open() throws synchronously', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = new LocalSource({
      factory: {
        open: () => {
          throw new Error('storage is blocked')
        },
      } as unknown as IDBFactory,
    })

    source.record(event())
    await source.flush()

    expect(await source.queryEvents()).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('degrades when open() never settles', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = new LocalSource({
      // A blocked upgrade — another tab holding an older version — fires
      // neither success nor error. Without the open timeout the console hangs
      // on a spinner forever.
      factory: { open: () => ({}) as IDBOpenDBRequest } as unknown as IDBFactory,
    })

    source.record(event())
    const flushed = source.flush()
    await vi.advanceTimersByTimeAsync(4000)
    await flushed

    expect(warn).toHaveBeenCalled()
    vi.useRealTimers()
    warn.mockRestore()
  })
})
