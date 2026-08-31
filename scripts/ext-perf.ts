/**
 * Latency of the browser enforcement path — `npm run check:ext`.
 *
 * Measures exactly what the extension does on a paste: the synchronous scan
 * plus the policy decision, which together are the whole fast path. Reports
 * percentiles rather than a mean, because a paste that is usually instant and
 * occasionally not is the failure people actually notice.
 */
import { scan } from '../src/engine/detect'
import { DEFAULT_POLICY, evaluate } from '../src/engine/policy'

interface Sample {
  name: string
  text: string
  expect: 'allow' | 'warn' | 'block'
}

const SAMPLES: Sample[] = [
  {
    name: 'short question',
    text: 'Can you help me write a polite reply declining this meeting?',
    expect: 'allow',
  },
  {
    name: 'code question',
    text: 'Why does this Python loop raise a KeyError when the dictionary clearly has that key? I have tried .get() and it still fails on the third iteration.',
    expect: 'allow',
  },
  {
    name: 'pasted article (2 kb)',
    text: `Kubernetes rolling restarts are a common source of confusion. ${'The controller replaces pods one at a time, honouring the surge and unavailability budgets configured on the deployment. '.repeat(14)}`,
    expect: 'allow',
  },
  {
    name: 'customer email',
    text: 'Help me rewrite this: Sarah Mitchell from Northwind contacted us at sarah.mitchell@example.com about case CASE-49281.',
    expect: 'warn',
  },
  {
    name: 'pasted credential',
    text: 'Here is the key sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b — show me how to call the endpoint.',
    expect: 'block',
  },
  {
    name: 'long pasted document (32 kb)',
    text: Array.from(
      { length: 120 },
      (_, i) =>
        `Case CASE-${40000 + i} was raised by Sarah Mitchell at ACME Holdings. Contact sarah.mitchell@example.com or +27 82 555 0${String(i % 900).padStart(3, '0')}. Server SQL-PROD-0${i % 9} at 10.20.${i % 250}.${(i * 7) % 250}.`,
    ).join('\n'),
    expect: 'warn',
  },
]

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

const RUNS = 200

console.log(`node ${process.version}\n`)
console.log(
  'paste path'.padEnd(28) +
    'chars'.padStart(8) +
    'P50'.padStart(10) +
    'P95'.padStart(10) +
    'P99'.padStart(10) +
    'decision'.padStart(10),
)
console.log('─'.repeat(76))

let worstP99 = 0

for (const sample of SAMPLES) {
  // Warm up, then measure the exact work the background worker performs.
  evaluate(scan(sample.text), DEFAULT_POLICY)

  const times: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now()
    evaluate(scan(sample.text), DEFAULT_POLICY)
    times.push(performance.now() - started)
  }

  const outcome = evaluate(scan(sample.text), DEFAULT_POLICY)
  const p99 = percentile(times, 99)
  worstP99 = Math.max(worstP99, p99)

  const flag = outcome.decision === sample.expect ? '' : '  ← unexpected'
  console.log(
    sample.name.padEnd(28) +
      sample.text.length.toLocaleString().padStart(8) +
      `${percentile(times, 50).toFixed(3)}`.padStart(10) +
      `${percentile(times, 95).toFixed(3)}`.padStart(10) +
      `${p99.toFixed(3)}`.padStart(10) +
      outcome.decision.padStart(10) +
      flag,
  )
}

console.log('\nAll figures in milliseconds, engine time only.')
console.log(
  'Message-passing to the worker adds roughly 0.1–1 ms in Chrome; there is no',
)
console.log('socket, no server and no model on this path.')
console.log(`\nworst P99 across every sample: ${worstP99.toFixed(3)} ms`)
