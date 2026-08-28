/**
 * Performance harness — `npm run check:perf`.
 *
 * Reports per-layer and end-to-end latency for representative workloads, plus
 * whether the selective confirmation path was needed. Run it before and after
 * an engine change; the numbers are the argument.
 */
import { DETECTORS, scan, scanWithConfirmation } from '../src/engine/detect'
import { getLocalModel } from '../src/engine/confirm'
import { DEMO_PROMPT } from '../src/demo/samples'

const SHORT = 'why did this backup fail and what should I check'

const MEDIUM = DEMO_PROMPT

// A realistic large document: a case export with recurring entities.
const LARGE = Array.from({ length: 900 }, (_, i) =>
  [
    `Case CASE-${40000 + i} was raised by Sarah Mitchell at ACME Holdings.`,
    `Contact sarah.mitchell@example.com or +27 82 555 0${String(i % 900).padStart(3, '0')}.`,
    `Server SQL-PROD-${String(i % 40).padStart(2, '0')} at 10.20.${i % 250}.${(i * 7) % 250} failed at 02:14.`,
    `Customer CUST-${800000 + i}, contract CTR-${770000 + i}. Christian values guided the review.`,
    `Version 12.1.2.4 shipped in May. The London office signed off ISO 27001.`,
  ].join(' '),
).join('\n\n')

/**
 * Deliberately ambiguous: unknown names and everyday-word names that the
 * gazetteers cannot settle on their own. This is the workload that should
 * actually reach the confirmer.
 */
const AMBIGUOUS = `Adeyemi confirmed the migration window this morning.
Christian joined the review and Mark reviewed the invoice afterwards.
Rose from the finance team called about the renewal.
Oyelaran Babatunde will pick up the handover from Thandeka Mokoena.
Christian values are important to the organisation, and the May release slipped.`

const WORKLOADS = [
  { name: 'short', text: SHORT },
  { name: 'medium', text: MEDIUM },
  { name: 'ambiguous', text: AMBIGUOUS },
  { name: 'large', text: LARGE },
]

function time(fn: () => unknown, iterations: number): number {
  fn() // warm up
  const started = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  return (performance.now() - started) / iterations
}

const ms = (n: number) => `${n.toFixed(3)} ms`.padStart(12)

console.log(`node ${process.version}\n`)
console.log(
  'workload'.padEnd(10) +
    'chars'.padStart(9) +
    'layer 1'.padStart(13) +
    'layer 2'.padStart(13) +
    'layer 3'.padStart(13) +
    'full scan'.padStart(13) +
    'findings'.padStart(10) +
    'escalated'.padStart(11),
)
console.log('─'.repeat(92))

for (const workload of WORKLOADS) {
  const iterations = workload.text.length > 50_000 ? 5 : 200
  const layers = DETECTORS.map((d) =>
    time(() => d.run(workload.text), iterations),
  )
  const full = time(() => scan(workload.text), iterations)
  const result = scan(workload.text)
  const escalated = result.ambiguous?.length ?? 0

  console.log(
    workload.name.padEnd(10) +
      workload.text.length.toLocaleString().padStart(9) +
      ms(layers[0] ?? 0) +
      ms(layers[1] ?? 0) +
      ms(layers[2] ?? 0) +
      ms(full) +
      String(result.findings.length).padStart(10) +
      String(escalated).padStart(11),
  )
}

// ---------------------------------------------------------------------------
// The escalation gate. The number that matters is whether the expensive path
// runs when it is not needed.
// ---------------------------------------------------------------------------
console.log('\nselective confirmation')
console.log('─'.repeat(92))
console.log(
  'workload'.padEnd(12) +
    'ambiguous'.padStart(11) +
    'invoked'.padStart(9) +
    'confirmed'.padStart(11) +
    'rejected'.padStart(10) +
    'confirm ms'.padStart(12) +
    'total ms'.padStart(11),
)

for (const workload of WORKLOADS) {
  const started = performance.now()
  const result = await scanWithConfirmation(workload.text)
  const total = performance.now() - started
  const e = result.escalation

  console.log(
    workload.name.padEnd(12) +
      String(e.ambiguous).padStart(11) +
      (e.modelInvoked ? 'YES' : 'no').padStart(9) +
      String(e.confirmed).padStart(11) +
      String(e.rejected).padStart(10) +
      `${e.ms.toFixed(2)}`.padStart(12) +
      `${total.toFixed(2)}`.padStart(11),
  )
}

// Memory: scan the large document repeatedly and watch the heap.
if (global.gc) global.gc()
const before = process.memoryUsage().heapUsed
for (let i = 0; i < 5; i++) scan(LARGE)
const after = process.memoryUsage().heapUsed
console.log(
  `\nheap after 5 large scans: ${((after - before) / 1024 / 1024).toFixed(1)} MB delta`,
)
console.log(`confirmer: ${getLocalModel().id} (${getLocalModel().cost.bytes} bytes to provision)`)
