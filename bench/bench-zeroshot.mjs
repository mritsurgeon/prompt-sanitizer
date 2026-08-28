/**
 * Benchmarks a zero-shot NLI classifier (DeBERTa-v3-small, int8 ONNX) on the
 * same held-out classification set the deterministic engine is scored on, so
 * the decision to ship it or not stays a measurement rather than an opinion.
 *
 *   # 1. provision the model once (~188 MB), into bench/zs
 *   B=https://huggingface.co/Xenova/nli-deberta-v3-small/resolve/main
 *   mkdir -p bench/zs/onnx
 *   for f in config.json tokenizer.json tokenizer_config.json \
 *            special_tokens_map.json added_tokens.json spm.model; do
 *     curl -sL -o bench/zs/$f $B/$f
 *   done
 *   curl -sL -o bench/zs/onnx/model_quantized.onnx $B/onnx/model_quantized.onnx
 *
 *   # 2. install the runtime ad hoc — deliberately NOT a project dependency
 *   npm install --no-save @xenova/transformers
 *
 *   # 3. run
 *   node bench/bench-zeroshot.mjs bench/heldout-classification.json
 *
 * Compare against: npm run check:classify
 *
 * Note the label-count multiplier: NLI zero-shot costs one forward pass per
 * candidate label, so 16 document types + 10 topics is 26 passes per document.
 * See the README for the measured verdict.
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mb = (b) => (b / 1024 / 1024).toFixed(1)

const cases = JSON.parse(
  readFileSync(process.argv[2] ?? path.join(here, 'heldout-classification.json'), 'utf8'),
)

const TYPE_LABELS = {
  nda: 'a non-disclosure agreement',
  msa: 'a master services agreement',
  sow: 'a statement of work',
  contract: 'a contract or agreement',
  invoice: 'an invoice',
  purchase_order: 'a purchase order',
  quote: 'a quote or proposal',
  meeting_notes: 'meeting notes',
  policy: 'a policy document',
  specification: 'a design or technical specification',
  roadmap: 'a product roadmap or plan',
  report: 'a report',
  support_case: 'a customer support case',
  correspondence: 'an email or letter',
  cv: 'a CV or resume',
  payslip: 'a payslip or payroll document',
}

const TOPIC_LABELS = {
  ip: 'intellectual property',
  legal: 'legal',
  sales: 'sales',
  finance: 'finance',
  hr: 'human resources',
  it_security: 'information technology and security',
  procurement: 'procurement',
  marketing: 'marketing',
  product: 'product management',
  operations: 'business operations',
}

const before = process.memoryUsage().rss
console.log(`rss before load: ${mb(before)} MB`)

const { pipeline, env } = await import('@xenova/transformers')
env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = here

const t0 = performance.now()
const classifier = await pipeline('zero-shot-classification', process.env.ZS_MODEL_DIR ?? 'zs', {
  quantized: true,
})
const loadMs = performance.now() - t0
const afterLoad = process.memoryUsage().rss
console.log(`load: ${loadMs.toFixed(0)} ms`)
console.log(`rss after load: ${mb(afterLoad)} MB (delta ${mb(afterLoad - before)} MB)`)

const typeIds = Object.keys(TYPE_LABELS)
const typeText = typeIds.map((k) => TYPE_LABELS[k])
const topicIds = Object.keys(TOPIC_LABELS)
const topicText = topicIds.map((k) => TOPIC_LABELS[k])

let typeCorrect = 0
let topicCorrect = 0
const latencies = []

for (const c of cases) {
  const t = performance.now()
  const typeOut = await classifier(c.text, typeText, { multi_label: false })
  const topicOut = await classifier(c.text, topicText, { multi_label: true })
  latencies.push(performance.now() - t)

  const topType = typeIds[typeText.indexOf(typeOut.labels[0])]
  const typeScore = typeOut.scores[0]
  // "no clear type" is expressed as a low top score.
  const predictedType = typeScore >= 0.40 ? topType : null

  const topTopic = topicIds[topicText.indexOf(topicOut.labels[0])]
  const topicScore = topicOut.scores[0]
  const predictedTopic = topicScore >= 0.40 ? topTopic : null

  const typeOk = predictedType === c.documentType
  const topicOk = predictedTopic === c.topic
  if (typeOk) typeCorrect += 1
  if (topicOk) topicCorrect += 1

  console.log(
    `  ${typeOk ? 'ok  ' : 'MISS'} ${topicOk ? 'ok  ' : 'MISS'} ${c.name.padEnd(28)} type=${String(predictedType).padEnd(16)}(${typeScore.toFixed(2)}) topic=${String(predictedTopic).padEnd(12)}(${topicScore.toFixed(2)})`,
  )
}

const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length
console.log(`\ndocument type  ${typeCorrect}/${cases.length} (${((typeCorrect / cases.length) * 100).toFixed(1)}%)`)
console.log(`topic          ${topicCorrect}/${cases.length} (${((topicCorrect / cases.length) * 100).toFixed(1)}%)`)
console.log(`latency        mean ${mean.toFixed(0)} ms per document (${typeIds.length + topicIds.length} label passes)`)
console.log(`rss peak       ${mb(process.memoryUsage().rss)} MB`)
