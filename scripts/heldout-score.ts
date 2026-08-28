/**
 * Scores the deterministic engine against a held-out ambiguity set —
 * `npm run check:heldout -- <path-to-heldout.json>`.
 *
 * The point of "held out" is that the engine is NOT tuned against these cases.
 * It exists so the GLiNER comparison is honest: the in-repo corpus is one the
 * engine was developed against, and scoring 100% on your own training set
 * proves very little.
 */
import { readFileSync } from 'node:fs'
import { scanWithConfirmation } from '../src/engine/detect'
import { getLocalModel, registerLocalModel } from '../src/engine/confirm'
import { createGlinerConfirmer } from '../src/engine/confirm/gliner'

interface HeldOutCase {
  text: string
  value: string
  person: boolean
}

const file = process.argv[2]
if (!file) {
  console.error('usage: tsx scripts/heldout-score.ts <heldout.json>')
  process.exit(1)
}

const cases: HeldOutCase[] = JSON.parse(readFileSync(file, 'utf8'))

// `--gliner` swaps the deterministic confirmer for the real model, so the same
// scoring code measures both.
if (process.argv.includes('--gliner')) {
  registerLocalModel(
    createGlinerConfirmer({
      basePath: 'public/models',
      modelName: 'gliner-small',
      modelFile: 'public/models/gliner-small/onnx/model.onnx',
    }),
  )
}
console.log(`confirmer: ${getLocalModel().id}\n`)

let escalated = 0
let recovered = 0
let discovered = 0
let rejected = 0
let correct = 0
let truePositive = 0
let falsePositive = 0
let trueNegative = 0
let falseNegative = 0

for (const testCase of cases) {
  const result = await scanWithConfirmation(testCase.text)
  if (result.escalation.modelInvoked) escalated += 1
  recovered += result.escalation.recovered
  discovered += result.escalation.discovered
  rejected += result.escalation.rejected
  const found = result.findings.some(
    (f) =>
      f.category === 'PERSON' &&
      (f.value.toLowerCase().includes(testCase.value.toLowerCase()) ||
        testCase.value.toLowerCase().includes(f.value.toLowerCase())),
  )

  const ok = found === testCase.person
  if (ok) correct += 1
  if (found && testCase.person) truePositive += 1
  if (found && !testCase.person) falsePositive += 1
  if (!found && !testCase.person) trueNegative += 1
  if (!found && testCase.person) falseNegative += 1

  console.log(
    `  ${ok ? 'ok  ' : 'MISS'} ${testCase.person ? 'person    ' : 'not person'}  ${JSON.stringify(testCase.value).padEnd(24)} -> ${found ? 'person' : 'none'}`,
  )
}

const precision = truePositive / Math.max(1, truePositive + falsePositive)
const recall = truePositive / Math.max(1, truePositive + falseNegative)
const f1 = (2 * precision * recall) / Math.max(0.0001, precision + recall)

console.log(`\naccuracy   ${correct}/${cases.length} (${((correct / cases.length) * 100).toFixed(1)}%)`)
console.log(`precision  ${(precision * 100).toFixed(1)}%`)
console.log(`recall     ${(recall * 100).toFixed(1)}%`)
console.log(`f1         ${(f1 * 100).toFixed(1)}%`)
console.log(`tp ${truePositive}  fp ${falsePositive}  tn ${trueNegative}  fn ${falseNegative}`)
console.log(
  `\nescalated on ${escalated}/${cases.length} cases · rejected ${rejected} · recovered ${recovered} · discovered ${discovered}`,
)
const cost = getLocalModel().cost
if (cost.startupMs) {
  console.log(
    `model load ${cost.startupMs.toFixed(0)} ms · ${cost.perCandidateMs?.toFixed(1) ?? '—'} ms per candidate`,
  )
}
