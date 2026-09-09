/**
 * Metrics seam harness — `npm run check:metrics`.
 *
 * Proves the envelope end to end outside a browser: run scans, collect what
 * the engine emitted, and print the summary the console will read. Because the
 * engine depends only on the one-method write seam, this is the same code path
 * the app and the extension take — the only difference is which sink is
 * registered.
 *
 * It also asserts the guarantee that matters, on real output rather than in
 * prose: no emitted field contains any word from the scanned text.
 */
import { registerLocalModel, resetScheduler } from '../src/engine/confirm'
import type { LocalModelDetector } from '../src/engine/confirm'
import { scanWithConfirmation } from '../src/engine/detect'
import {
  memorySink,
  registerMetricsSink,
  summarise,
  type MetricsPhase,
} from '../src/engine/metrics'
import { DEMO_PROMPT } from '../src/demo/samples'

const AMBIGUOUS = `Adeyemi confirmed the migration window this morning.
Christian joined the review and Mark reviewed the invoice afterwards.
Rose from the finance team called about the renewal.
Oyelaran Babatunde will pick up the handover from Thandeka Mokoena.`

const CLEAN = 'why did this backup fail and what should I check'

/**
 * Stands in for GLiNER, which cannot load under `tsx` without the ONNX
 * runtime. The point here is the seam, not the model: a confirmer that reports
 * a runtime is what makes `ep` and `labelCount` observable, and this reports
 * one.
 */
function fakeModel(latencyMs: number): LocalModelDetector {
  let loaded = false
  return {
    id: 'harness-model',
    label: 'Harness model',
    cost: { bytes: 1_000_000, startupMs: null, perCandidateMs: null },
    runtime: { ep: 'wasm-threaded', labelCount: 2, tokenCountBucket: 128 },
    get loaded() {
      return loaded
    },
    isAvailable: async () => true,
    load: async () => {
      // Idempotent, as the seam requires: a resident model returns at once.
      // The 40 ms is the cold start, and the summary should attribute it to
      // the first call only.
      if (loaded) return
      await new Promise((r) => setTimeout(r, 40))
      loaded = true
    },
    confirm: async (requests) => {
      await new Promise((r) => setTimeout(r, latencyMs))
      return requests.map((r) => ({
        id: r.id,
        decision: 'confirm' as const,
        confidence: 0.95,
      }))
    },
  }
}

const sink = memorySink()
registerMetricsSink(sink)
registerLocalModel(fakeModel(8))

const WORKLOADS: Array<{ phase: MetricsPhase; text: string; label: string }> = [
  { phase: 'submit-gate', text: AMBIGUOUS, label: 'held send' },
  { phase: 'banner', text: AMBIGUOUS, label: 'behind a banner' },
  // Unambiguous on purpose: the gate should decline, so this surface shows
  // zero envelopes. An escalation that never happened is not a data point.
  { phase: 'overlay', text: DEMO_PROMPT, label: 'app overlay (unambiguous)' },
  { phase: 'file', text: AMBIGUOUS.repeat(4), label: 'dropped file' },
]

for (const workload of WORKLOADS) {
  resetScheduler() // otherwise each run supersedes the last, which is the point
  await scanWithConfirmation(workload.text, { phase: workload.phase })
}

// The gate: a clean prompt must emit nothing at all.
const before = sink.events.length
await scanWithConfirmation(CLEAN, { phase: 'submit-gate' })
const emittedForClean = sink.events.length - before

console.log('\nEnvelopes emitted')
console.log('─'.repeat(78))
const gateOutcome = (e: (typeof sink.events)[number]): string =>
  e.circuitBreakerTripped
    ? 'circuit open'
    : e.coldDeclined
      ? 'cold declined'
      : e.superseded
        ? 'superseded'
        : e.timedOut
          ? 'timed out'
          : e.escalated
            ? 'ran'
            : 'skipped'

console.log(
  'surface'.padEnd(14) +
    'gate'.padEnd(15) +
    'cold'.padStart(6) +
    'batch'.padStart(7) +
    'window'.padStart(8) +
    'labels'.padStart(8) +
    'ms'.padStart(9),
)
for (const e of sink.events) {
  console.log(
    e.phase.padEnd(14) +
      gateOutcome(e).padEnd(15) +
      (e.coldStart ? 'yes' : 'no').padStart(6) +
      String(e.batchSize).padStart(7) +
      String(e.windowCharsBucket).padStart(8) +
      String(e.labelCount ?? '—').padStart(8) +
      e.durationMs.toFixed(1).padStart(9),
  )
}

console.log(`\nclean prompt emitted ${emittedForClean} envelopes (must be 0)`)

console.log('\nSummary, per surface — budgets differ, so they never mix')
console.log('─'.repeat(78))
console.log(
  'surface'.padEnd(14) +
    'events'.padStart(8) +
    'infer'.padStart(7) +
    'p50'.padStart(9) +
    'p95'.padStart(9) +
    'cold p50'.padStart(10) +
    'super%'.padStart(9) +
    't/out%'.padStart(9),
)
for (const phase of ['submit-gate', 'banner', 'overlay', 'file'] as const) {
  const s = summarise(sink.events, { phase })
  console.log(
    phase.padEnd(14) +
      String(s.events).padStart(8) +
      String(s.inferences).padStart(7) +
      s.p50DurationMs.toFixed(1).padStart(9) +
      s.p95DurationMs.toFixed(1).padStart(9) +
      (s.p50ColdStartMs === null ? '—' : s.p50ColdStartMs.toFixed(0)).padStart(10) +
      `${(s.supersededRate * 100).toFixed(0)}%`.padStart(9) +
      `${(s.timeoutRate * 100).toFixed(0)}%`.padStart(9),
  )
}

const all = summarise(sink.events)
console.log(
  `\nall surfaces: ${all.events} events · ${all.inferences} inferences · ` +
    `p50 ${all.p50DurationMs.toFixed(1)} ms · p95 ${all.p95DurationMs.toFixed(1)} ms`,
)
console.log(`ep distribution: ${JSON.stringify(all.epDistribution)}`)
console.log(`confirmers: ${JSON.stringify(all.confirmerDistribution)}`)

// --- the guarantee, checked rather than asserted in prose -------------------
const corpus = [AMBIGUOUS, DEMO_PROMPT, CLEAN].join(' ')
const words = [...new Set(corpus.split(/[^\p{L}\p{N}@._-]+/u))].filter(
  (w) => w.length >= 4,
)
const leaks: string[] = []
for (const event of sink.events) {
  const values = JSON.stringify(Object.values(event))
  for (const word of words) if (values.includes(word)) leaks.push(word)
}

console.log('─'.repeat(78))
if (leaks.length || emittedForClean !== 0) {
  console.error(
    `FAIL — ${leaks.length} content leaks ${JSON.stringify([...new Set(leaks)].slice(0, 10))}` +
      `, ${emittedForClean} envelopes for a clean prompt`,
  )
  process.exit(1)
}
console.log(
  `PASS — ${sink.events.length} envelopes carry none of ${words.length} ` +
    `content words, and a clean prompt emitted nothing.`,
)
