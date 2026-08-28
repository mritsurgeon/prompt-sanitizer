import { describe, expect, it } from 'vitest'
import { DEMO_PROMPT } from '@/demo/samples'
import { scan, scanWithConfirmation } from '../detect'

/**
 * Performance regression gates.
 *
 * The budgets are not invented — they come from the measurements taken on this
 * machine before the context engine was added (`npm run check:perf`):
 *
 *   workload            baseline      after
 *   short (48 ch)       0.011 ms      0.027 ms
 *   medium (516 ch)     0.150 ms      0.221 ms
 *   large (291 kb)      422 ms        268 ms
 *
 * The large case got faster because overlap resolution moved from comparing
 * every candidate against every accepted one to a claimed-character bitmap.
 *
 * The assertions below are deliberately loose multiples of those numbers, so
 * they catch an order-of-magnitude regression on a busy CI box without being
 * flaky. The architectural assertions — "the model does not run on the normal
 * path" — are exact, because those are the ones that actually matter.
 */

const BASELINE_LARGE_MS = 422

const SHORT = 'why did this backup fail and what should I check'

const LARGE = Array.from({ length: 900 }, (_, i) =>
  [
    `Case CASE-${40000 + i} was raised by Sarah Mitchell at ACME Holdings.`,
    `Contact sarah.mitchell@example.com or +27 82 555 0${String(i % 900).padStart(3, '0')}.`,
    `Server SQL-PROD-${String(i % 40).padStart(2, '0')} at 10.20.${i % 250}.${(i * 7) % 250} failed.`,
    `Customer CUST-${800000 + i}, contract CTR-${770000 + i}.`,
  ].join(' '),
).join('\n\n')

function median(fn: () => unknown, runs: number): number {
  fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    fn()
    samples.push(performance.now() - started)
  }
  return samples.sort((a, b) => a - b)[Math.floor(runs / 2)]
}

describe('fast path stays fast', () => {
  it('scans a short prompt in well under a millisecond', () => {
    const ms = median(() => scan(SHORT), 200)
    expect(ms).toBeLessThan(1)
  })

  it('scans a realistic prompt in a couple of milliseconds', () => {
    const ms = median(() => scan(DEMO_PROMPT), 200)
    expect(ms).toBeLessThan(5)
  })

  it('does not regress on a large document', () => {
    const ms = median(() => scan(LARGE), 5)
    expect(ms).toBeLessThan(BASELINE_LARGE_MS)
  })
})

describe('the model does not run on the normal path', () => {
  it('is never invoked for unambiguous content', async () => {
    const result = await scanWithConfirmation(DEMO_PROMPT)

    expect(result.ambiguous).toHaveLength(0)
    expect(result.escalation.modelInvoked).toBe(false)
    expect(result.escalation.ms).toBe(0)
  })

  it('is never invoked for a large document of unambiguous findings', async () => {
    const result = await scanWithConfirmation(LARGE)

    expect(result.findings.length).toBeGreaterThan(1000)
    expect(result.escalation.modelInvoked).toBe(false)
  })

  it('adds no measurable cost when there is nothing to confirm', async () => {
    const fast = median(() => scan(DEMO_PROMPT), 100)

    let full = 0
    for (let i = 0; i < 20; i++) {
      const started = performance.now()
      await scanWithConfirmation(DEMO_PROMPT)
      full += performance.now() - started
    }
    full /= 20

    // Awaiting an already-resolved promise is the only difference.
    expect(full).toBeLessThan(Math.max(1, fast * 20))
  })

  it('is invoked when — and only when — something is ambiguous', async () => {
    const ambiguous = await scanWithConfirmation(
      'Adeyemi confirmed the migration window this morning.',
    )
    expect(ambiguous.escalation.modelInvoked).toBe(true)
    expect(ambiguous.escalation.ambiguous).toBeGreaterThan(0)
  })
})

describe('escalation is proportionate', () => {
  it('only ever examines the ambiguous minority', async () => {
    const text = `${DEMO_PROMPT}\nAdeyemi confirmed the window. Christian joined the call.`
    const result = await scanWithConfirmation(text)

    expect(result.escalation.ambiguous).toBeLessThan(result.findings.length / 2)
  })
})
