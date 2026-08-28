/**
 * Benchmarks GLiNER small v2.1 (int8 ONNX) as a selective PII confirmer, so the
 * decision to ship it or not stays a measurement rather than an opinion.
 *
 * Run it against the same held-out sets the deterministic engine is scored on:
 *
 *   # 1. provision the model once (~195 MB), into bench/model
 *   B=https://huggingface.co/onnx-community/gliner_small-v2.1/resolve/main
 *   mkdir -p bench/model/onnx
 *   for f in config.json gliner_config.json tokenizer.json \
 *            tokenizer_config.json special_tokens_map.json added_tokens.json; do
 *     curl -sL -o bench/model/$f $B/$f
 *   done
 *   curl -sL -o bench/model/onnx/model.onnx $B/onnx/model_quantized.onnx
 *
 *   # 2. install the runtime ad hoc — deliberately NOT a project dependency
 *   #    (npm reports 5 high + 1 critical advisory for this tree)
 *   npm install --no-save gliner onnxruntime-node
 *
 *   # 3. run
 *   node bench/bench-gliner.mjs bench/heldout-ambiguity-2.json
 *
 * Compare against: npm run check:heldout -- bench/heldout-ambiguity-2.json
 *
 * Nothing here runs in the app, and no model is loaded at runtime. See the
 * "Why no neural model ships" section of the README for the measured verdict.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = path.join(here, 'model')

const mb = (b) => (b / 1024 / 1024).toFixed(1)

import { readFileSync } from 'node:fs'
const CASES = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], 'utf8'))
  : [
  { text: 'Christian joined the meeting yesterday and raised two concerns.', value: 'Christian', person: true },
  { text: 'Christian values are important to the organisation.', value: 'Christian', person: false },
  { text: 'Mark reviewed the invoice and approved it.', value: 'Mark', person: true },
  { text: 'Mark the invoice as paid once the payment clears.', value: 'Mark', person: false },
  { text: 'Rose from the finance team called about the renewal.', value: 'Rose', person: true },
  { text: 'Grace period applies to all new accounts.', value: 'Grace', person: false },
  { text: 'Adeyemi confirmed the migration window this morning.', value: 'Adeyemi', person: true },
  { text: 'Oyelaran Babatunde will pick up the handover.', value: 'Oyelaran Babatunde', person: true },
  { text: 'We run Kubernetes and Docker in production.', value: 'Docker', person: false },
  { text: 'Amazon released its quarterly results this morning.', value: 'Amazon', person: false },
  { text: 'Will the backup job run again tonight?', value: 'Will', person: false },
  { text: 'Bill the customer for the extra hours.', value: 'Bill', person: false },
  { text: 'Faith in the process matters.', value: 'Faith', person: false },
  { text: 'Victor raised a concern about the rollout.', value: 'Victor', person: true },
  { text: 'The May release slipped by a week.', value: 'May', person: false },
  { text: 'Thandeka Mokoena signed the renewal this morning.', value: 'Thandeka Mokoena', person: true },
]

const before = process.memoryUsage().rss
console.log(`rss before load: ${mb(before)} MB`)

const { Gliner } = await import('gliner/node')

// Force fully-local resolution AFTER gliner's own module init, which resets
// these flags for browser use.
const { env } = await import('@xenova/transformers')
env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = here
env.useFSCache = false

const t0 = performance.now()
const gliner = new Gliner({
  tokenizerPath: 'model',
  onnxSettings: {
    modelPath: path.join(MODEL_DIR, 'onnx', 'model.onnx'),
    executionProviders: ['cpu'],
  },
  maxWidth: 12,
  modelType: 'span-level',
  transformersSettings: { allowLocalModels: true, useBrowserCache: false },
})
await gliner.initialize()
const loadMs = performance.now() - t0
const afterLoad = process.memoryUsage().rss

console.log(`load: ${loadMs.toFixed(0)} ms`)
console.log(`rss after load: ${mb(afterLoad)} MB (delta ${mb(afterLoad - before)} MB)`)

const ENTITIES = ['person']

// Warm up (first inference includes graph warm-up).
const w0 = performance.now()
await gliner.inference({ texts: [CASES[0].text], entities: ENTITIES })
console.log(`first inference: ${(performance.now() - w0).toFixed(0)} ms`)

let correct = 0
const latencies = []
const rows = []

for (const c of CASES) {
  const t = performance.now()
  const out = await gliner.inference({ texts: [c.text], entities: ENTITIES })
  latencies.push(performance.now() - t)

  const spans = (out?.[0] ?? []).filter((s) => (s.label ?? '').toLowerCase() === 'person')
  const found = spans.some(
    (s) =>
      c.value.toLowerCase().includes((s.text ?? '').toLowerCase()) ||
      (s.text ?? '').toLowerCase().includes(c.value.toLowerCase()),
  )
  const ok = found === c.person
  if (ok) correct += 1
  rows.push(
    `  ${ok ? 'ok  ' : 'MISS'} ${c.person ? 'person    ' : 'not person'}  ${JSON.stringify(c.value).padEnd(22)} -> ${found ? 'person' : 'none'}   ${JSON.stringify(spans.map((s) => `${s.text}:${(s.score ?? 0).toFixed(2)}`)).slice(0, 70)}`,
  )
}

console.log(rows.join('\n'))

latencies.sort((a, b) => a - b)
const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length
const tp = CASES.filter((c,i)=>c.person && rows[i].startsWith('  ok')).length
const fn = CASES.filter(c=>c.person).length - tp
const fp = CASES.filter((c,i)=>!c.person && rows[i].startsWith('  MISS')).length
const prec = tp/Math.max(1,tp+fp), rec = tp/Math.max(1,tp+fn)
console.log(`\naccuracy on ambiguous cases: ${correct}/${CASES.length} (${((correct / CASES.length) * 100).toFixed(1)}%)`)
console.log(`precision ${(prec*100).toFixed(1)}%  recall ${(rec*100).toFixed(1)}%  f1 ${((2*prec*rec/Math.max(0.0001,prec+rec))*100).toFixed(1)}%  tp ${tp} fp ${fp} fn ${fn}`)
console.log(`inference per candidate: mean ${mean.toFixed(1)} ms, median ${latencies[Math.floor(latencies.length / 2)].toFixed(1)} ms, max ${latencies.at(-1).toFixed(1)} ms`)
console.log(`rss peak: ${mb(process.memoryUsage().rss)} MB`)
