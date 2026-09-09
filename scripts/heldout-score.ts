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
import {
  getLocalModel,
  getWindowStrategy,
  registerLocalModel,
  resetScheduler,
  setWindowStrategy,
} from '../src/engine/confirm'
import { createGlinerConfirmer } from '../src/engine/confirm/gliner'
import { memorySink, registerMetricsSink } from '../src/engine/metrics'

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
/**
 * `--merge-windows` merges overlapping confirmer windows.
 *
 * It only does anything on documents holding several candidates, and every
 * case in these sets is one sentence — so `--group N` packs cases into
 * documents first. Grouping is **value-disjoint on purpose**: these sets are
 * built around the same word appearing once as a person and once as not
 * ("Chase" the colleague, "Chase" the bank), and putting both in one document
 * would pit the expected labels against the engine's own entity-consistency
 * pass. That would measure the grouping, not the windowing.
 */
if (process.argv.includes('--merge-windows')) {
  const capFlag = process.argv.indexOf('--cap')
  setWindowStrategy({
    merge: true,
    ...(capFlag === -1 ? {} : { maxChars: Number(process.argv[capFlag + 1]) }),
  })
}

const groupFlag = process.argv.indexOf('--group')
const groupSize = groupFlag === -1 ? 1 : Number(process.argv[groupFlag + 1] || 4)

interface Group {
  text: string
  members: Array<{ testCase: HeldOutCase; from: number; to: number }>
}

function groupCases(all: HeldOutCase[], size: number): Group[] {
  const bins: Array<{ cases: HeldOutCase[]; values: Set<string> }> = []
  for (const testCase of all) {
    const key = testCase.value.toLowerCase()
    const bin = bins.find((b) => b.cases.length < size && !b.values.has(key))
    if (bin) {
      bin.cases.push(testCase)
      bin.values.add(key)
    } else {
      bins.push({ cases: [testCase], values: new Set([key]) })
    }
  }

  return bins.map((bin) => {
    const members: Group['members'] = []
    let text = ''
    for (const testCase of bin.cases) {
      const from = text.length
      text += testCase.text
      members.push({ testCase, from, to: text.length })
      text += '\n'
    }
    return { text, members }
  })
}

const groups = groupCases(cases, groupSize)

console.log(`confirmer: ${getLocalModel().id}`)
console.log(
  `windows:   ${getWindowStrategy().merge ? `merged (cap ${getWindowStrategy().maxChars})` : 'one per candidate'}`,
)
console.log(
  `documents: ${groups.length} (${groupSize} case${groupSize === 1 ? '' : 's'} per document, value-disjoint)\n`,
)

let escalated = 0
let recovered = 0
let discovered = 0
let rejected = 0
let correct = 0
let truePositive = 0
let falsePositive = 0
let trueNegative = 0
let falseNegative = 0

// The metrics seam earning its keep: window count per escalation is exactly
// the number this comparison is about, and it is already on the envelope.
const sink = memorySink()
registerMetricsSink(sink)

for (const group of groups) {
  // Each document is its own escalation, not a supersession of the last.
  resetScheduler()
  const result = await scanWithConfirmation(group.text, { phase: 'harness' })
  if (result.escalation.modelInvoked) escalated += 1
  recovered += result.escalation.recovered
  discovered += result.escalation.discovered
  rejected += result.escalation.rejected

  for (const { testCase, from, to } of group.members) {
    // Attributed by position, not by value alone: a substring match across a
    // multi-case document would credit one case for another's finding.
    const found = result.findings.some(
      (f) =>
        f.category === 'PERSON' &&
        f.start >= from &&
        f.end <= to &&
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
  `\nescalated on ${escalated}/${groups.length} documents · rejected ${rejected} · recovered ${recovered} · discovered ${discovered}`,
)
const ran = sink.events.filter((e) => e.escalated)
const windows = ran.reduce((n, e) => n + e.windowCount, 0)
const candidates = ran.reduce((n, e) => n + e.batchSize, 0)
const totalMs = ran.reduce((n, e) => n + e.durationMs, 0)
if (windows) {
  console.log(
    `windows ${windows} for ${candidates} candidates ` +
      `(${(candidates / windows).toFixed(2)} candidates per window) · ` +
      `${totalMs.toFixed(0)} ms of confirmation across ${ran.length} escalations`,
  )
}
const cost = getLocalModel().cost
if (cost.startupMs) {
  console.log(
    `model load ${cost.startupMs.toFixed(0)} ms · ${cost.perCandidateMs?.toFixed(1) ?? '—'} ms per candidate`,
  )
}
