import { describe, expect, it } from 'vitest'
import { DEMO_PROMPT } from '@/demo/samples'
import { scan, scanWithConfirmation } from '../detect'

/**
 * Performance regression gates.
 *
 * The budgets are not invented — they come from measurements on this machine
 * (`npm run check:perf`), taken before the context engine was added and again
 * after the linear-scaling pass:
 *
 *   workload            original      + context      linear
 *   short (48 ch)       0.011 ms      0.027 ms       0.011 ms
 *   medium (516 ch)     0.150 ms      0.221 ms       0.117 ms
 *   large (291 kb)      422 ms        382 ms         222 ms
 *
 * Three passes over the document used to be quadratic in its length: masking
 * identifiers rebuilt the whole string once per identifier, and two context
 * helpers sliced to the start or the end of the document once per candidate.
 * All three are now bounded, and per-character cost is flat from 46 kb to
 * 738 kb where it used to rise by 2.3x across that range.
 *
 * The short and medium assertions are deliberately loose multiples, so they
 * catch an order-of-magnitude regression on a busy CI box without being flaky.
 * The architectural assertions — "the model does not run on the normal path" —
 * are exact, because those are the ones that actually matter.
 *
 * The large-document gate is a *scaling* assertion rather than a stopwatch.
 * An absolute millisecond ceiling measures the machine as much as the code —
 * it fails on a laptop whose antivirus happens to be busy, which teaches
 * everyone to ignore it. What can actually regress here is the complexity, so
 * the test quadruples the input and checks the time does not rise by much more
 * than 4x, which holds on a fast machine and a loaded one alike.
 */

/**
 * The gate spans a 4x size difference, where linear costs ~4x and quadratic
 * ~16x. The ceiling sits between the two with room on both sides: this engine
 * measures ~3.7x, and the quadratic version it replaced measured ~9.6x. A
 * narrower span would put the two closer together than the run-to-run noise.
 */
const MAX_SCALING_FACTOR = 6

const SHORT = 'why did this backup fail and what should I check'

const document_ = (paragraphs: number) =>
  Array.from({ length: paragraphs }, (_, i) =>
  [
    `Case CASE-${40000 + i} was raised by Sarah Mitchell at ACME Holdings.`,
    `Contact sarah.mitchell@example.com or +27 82 555 0${String(i % 900).padStart(3, '0')}.`,
    `Server SQL-PROD-${String(i % 40).padStart(2, '0')} at 10.20.${i % 250}.${(i * 7) % 250} failed.`,
    `Customer CUST-${800000 + i}, contract CTR-${770000 + i}.`,
  ].join(' '),
  ).join('\n\n')

const SMALL = document_(450) // ~92 kb
const LARGE = document_(1800) // ~369 kb

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

/**
 * The fastest of several runs, rather than the median.
 *
 * Interference only ever adds time — a GC pause, another test file's heap, an
 * antivirus scan mid-run. The quickest observed run is therefore the least
 * contaminated estimate of what the code actually costs, and it is what keeps
 * a ratio between two workloads meaningful on a machine under load.
 */
function fastest(fn: () => unknown, runs: number): number {
  fn()
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    fn()
    best = Math.min(best, performance.now() - started)
  }
  return best
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

  it('scales linearly with document size rather than quadratically', () => {
    // Interleaved, so a thermal or scheduling shift partway through the test
    // lands on both measurements rather than only the second one.
    const small = fastest(() => scan(SMALL), 4)
    const large = fastest(() => scan(LARGE), 4)
    const smallAgain = fastest(() => scan(SMALL), 4)

    const baseline = Math.min(small, smallAgain)
    expect(LARGE.length / SMALL.length).toBeCloseTo(4, 1)
    expect(large / baseline).toBeLessThan(MAX_SCALING_FACTOR)
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
