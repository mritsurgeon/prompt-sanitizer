import { afterEach, describe, expect, it } from 'vitest'
import {
  WINDOW_RADIUS,
  getWindowStrategy,
  registerLocalModel,
  resetGuard,
  resetLocalModel,
  resetScheduler,
  resetWindowStrategy,
  setWindowStrategy,
  type ConfirmationRequest,
  type LocalModelDetector,
} from '../confirm'
import { scanWithConfirmation } from '../detect'
import { resetMetricsSink } from '../metrics'

/**
 * Window construction for the confirmer.
 *
 * Candidates in neighbouring sentences produce windows that overlap almost
 * entirely, so the model reads the same prose once per candidate. Merging them
 * is a large win — measured 269 ms to 43 ms on a dense document — and the risk
 * it carries is entirely about offsets: every request has to keep pointing at
 * its own value inside a window it now shares with others. Get that wrong and
 * verdicts land on the wrong findings, silently.
 */

/** Dense on purpose: every sentence contains an ambiguous candidate. */
const DENSE = `Adeyemi confirmed the migration window this morning.
Christian joined the review and Mark reviewed the invoice afterwards.
Rose from the finance team called about the renewal.
Oyelaran Babatunde will pick up the handover from Thandeka Mokoena.`

/** Two candidates separated by more text than two window radii. */
const FAR_APART = `Adeyemi confirmed the migration window this morning.
${'The nightly job completed normally and nothing else of note occurred. '.repeat(12)}
Thandeka Mokoena will pick up the handover next Tuesday.`

function capturingModel(): LocalModelDetector & {
  seen: ConfirmationRequest[]
} {
  const seen: ConfirmationRequest[] = []
  let loaded = false
  return {
    id: 'capture',
    label: 'Capturing model',
    cost: { bytes: 1_000_000, startupMs: null, perCandidateMs: null },
    seen,
    get loaded() {
      return loaded
    },
    isAvailable: async () => true,
    load: async () => {
      loaded = true
    },
    confirm: async (requests) => {
      seen.push(...requests)
      return requests.map((r) => ({
        id: r.id,
        decision: 'confirm' as const,
        confidence: 0.95,
      }))
    },
  }
}

const distinctWindows = (requests: ConfirmationRequest[]) =>
  new Set(requests.map((r) => r.window)).size

afterEach(() => {
  resetLocalModel()
  resetMetricsSink()
  resetScheduler()
  resetGuard()
  resetWindowStrategy()
})

describe('the default strategy', () => {
  it('does not merge, because merging costs recall', () => {
    const strategy = getWindowStrategy()
    // Scored with GLiNER over 564 labelled positives in 90 dense documents:
    // recall 73.9% unmerged, 72.7% at cap 250, 70.7% at cap 350, 62.6% at
    // cap 800. A missed finding is a leak and the 2.3x it buys is spent behind
    // a banner nobody is waiting on. Pinned so turning it back on is a
    // deliberate act with a failing test attached.
    expect(strategy.merge).toBe(false)
    // The cap still has to exceed a single candidate window, or enabling it
    // could never combine anything.
    expect(strategy.maxChars).toBeGreaterThan(WINDOW_RADIUS)
  })

  it('cuts one window per candidate', async () => {
    const model = capturingModel()
    registerLocalModel(model)
    await scanWithConfirmation(DENSE, { phase: 'harness' })

    expect(distinctWindows(model.seen)).toBe(model.seen.length)
  })
})

describe('merging overlapping windows', () => {
  it('collapses a dense document to far fewer windows', async () => {
    const model = capturingModel()
    registerLocalModel(model)
    setWindowStrategy({ merge: true, maxChars: 1200 })

    await scanWithConfirmation(DENSE, { phase: 'harness' })

    expect(model.seen.length).toBeGreaterThan(3)
    expect(distinctWindows(model.seen)).toBeLessThan(model.seen.length)
    // The whole point: the model reads the region once, not once per candidate.
    const totalChars = [...new Set(model.seen.map((r) => r.window))].reduce(
      (n, w) => n + w.length,
      0,
    )
    const unmergedChars = model.seen.reduce((n, r) => n + r.window.length, 0)
    expect(totalChars).toBeLessThan(unmergedChars / 2)
  })

  it('keeps every offset pointing at its own value', async () => {
    const model = capturingModel()
    registerLocalModel(model)
    setWindowStrategy({ merge: true })

    await scanWithConfirmation(DENSE, { phase: 'harness' })

    expect(model.seen.length).toBeGreaterThan(0)
    for (const request of model.seen) {
      // The invariant merging could break, and the one that would corrupt
      // verdicts silently if it did.
      expect(request.window.slice(request.offset, request.offset + request.value.length)).toBe(
        request.value,
      )
    }
  })

  it('keeps windowStart absolute, so discovery still maps back', async () => {
    const model = capturingModel()
    registerLocalModel(model)
    setWindowStrategy({ merge: true })

    await scanWithConfirmation(DENSE, { phase: 'harness' })

    for (const request of model.seen) {
      // A discovered span is reported as windowStart + span.start, so this has
      // to be the window's real position in the document.
      expect(DENSE.slice(request.windowStart, request.windowStart + request.window.length)).toBe(
        request.window,
      )
    }
  })

  it('does not bridge candidates that never overlapped', async () => {
    const model = capturingModel()
    registerLocalModel(model)
    setWindowStrategy({ merge: true })

    await scanWithConfirmation(FAR_APART, { phase: 'harness' })

    // Two candidates a thousand characters apart have nothing to say about
    // each other, and bridging them would hand over text neither needed.
    expect(distinctWindows(model.seen)).toBeGreaterThan(1)
    for (const request of model.seen) {
      expect(request.window.length).toBeLessThan(600)
    }
  })

  it('never exceeds the cap', async () => {
    const model = capturingModel()
    registerLocalModel(model)
    setWindowStrategy({ merge: true, maxChars: 400 })

    // Long and uniformly dense, so an uncapped merge would run away.
    await scanWithConfirmation([DENSE, DENSE, DENSE, DENSE].join('\n'), {
      phase: 'harness',
    })

    expect(model.seen.length).toBeGreaterThan(4)
    for (const request of model.seen) {
      // The cap exists because position embeddings run out, and because an
      // unbounded merge converges on handing over the whole document.
      expect(request.window.length).toBeLessThanOrEqual(400)
      expect(request.window.slice(request.offset, request.offset + request.value.length)).toBe(
        request.value,
      )
    }
  })

  it('adjudicates the same candidates either way', async () => {
    setWindowStrategy({ merge: false })
    const plain = capturingModel()
    registerLocalModel(plain)
    await scanWithConfirmation(DENSE, { phase: 'harness' })
    const before = new Set(plain.seen.map((r) => `${r.value}@${r.windowStart + r.offset}`))

    resetScheduler()
    const merged = capturingModel()
    registerLocalModel(merged)
    setWindowStrategy({ merge: true })
    await scanWithConfirmation(DENSE, { phase: 'harness' })
    const after = new Set(merged.seen.map((r) => `${r.value}@${r.windowStart + r.offset}`))

    // Merging changes how much text the model sees, not which candidates it is
    // asked about. If this set changes, something other than windowing moved.
    expect([...after].sort()).toEqual([...before].sort())
  })

  it('reports the window count on the envelope', async () => {
    const { memorySink, registerMetricsSink } = await import('../metrics')
    const sink = memorySink()
    registerMetricsSink(sink)
    registerLocalModel(capturingModel())
    setWindowStrategy({ merge: true })

    await scanWithConfirmation(DENSE, { phase: 'harness' })

    const event = sink.events[0]
    expect(event.windowCount).toBeGreaterThan(0)
    // The number to watch when tuning: window count drives cost, label count
    // barely moves it.
    expect(event.windowCount).toBeLessThan(event.batchSize)
  })
})
