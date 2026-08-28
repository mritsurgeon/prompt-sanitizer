/**
 * Scores the deterministic classifier against a held-out set —
 * `npm run check:classify -- bench/heldout-classification.json`.
 *
 * Reports document-type and topic accuracy, plus latency, so it can be
 * compared directly against a zero-shot model on the same data.
 */
import { readFileSync } from 'node:fs'
import { classifyDocument } from '../src/engine/classify'

interface Case {
  name: string
  filename?: string
  text: string
  documentType: string | null
  topic: string | null
}

const file = process.argv[2] ?? 'bench/heldout-classification.json'
const cases: Case[] = JSON.parse(readFileSync(file, 'utf8'))

let typeCorrect = 0
let topicCorrect = 0
const latencies: number[] = []

for (const testCase of cases) {
  const started = performance.now()
  const result = classifyDocument(testCase.text, {
    filename: testCase.filename,
  })
  latencies.push(performance.now() - started)

  const type = result.documentType?.id ?? null
  const topics = result.topics.map((t) => t.id)

  const typeOk = type === testCase.documentType
  const topicOk = testCase.topic === null
    ? topics.length === 0
    : topics.includes(testCase.topic)

  if (typeOk) typeCorrect += 1
  if (topicOk) topicCorrect += 1

  console.log(
    `  ${typeOk ? 'ok  ' : 'MISS'} ${topicOk ? 'ok  ' : 'MISS'} ${testCase.name.padEnd(28)} type=${String(type).padEnd(16)} topics=${topics.join(',') || '—'}`,
  )
}

const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length
console.log(
  `\ndocument type  ${typeCorrect}/${cases.length} (${((typeCorrect / cases.length) * 100).toFixed(1)}%)`,
)
console.log(
  `topic          ${topicCorrect}/${cases.length} (${((topicCorrect / cases.length) * 100).toFixed(1)}%)`,
)
console.log(`latency        mean ${mean.toFixed(3)} ms per document`)
