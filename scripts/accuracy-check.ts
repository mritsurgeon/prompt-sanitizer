/**
 * Accuracy gate for a model artifact — `npm run bench:accuracy [-- <dir>]`.
 *
 * Scores one confirmer checkpoint on everything that can currently detect a
 * regression, and prints the four numbers together, because a change to weights
 * or windowing can move any one of them without touching the others:
 *
 *  - **held-out F1, both sets** — precision on ambiguity the engine was not
 *    tuned against;
 *  - **dense findings** — a multi-candidate document, which is the only thing
 *    here that exercises window merging at all;
 *  - **rare-name recall** — names no gazetteer contains, which is the single
 *    documented reason a model is in this product. A change that holds F1 and
 *    breaks this has broken the feature and passed the benchmark.
 *
 * One model per invocation, on purpose. Model and tokenizer loading is
 * process-global in `transformers`, and comparing checkpoints inside one
 * process invites a result that describes whichever loaded first.
 *
 *     npm run bench:accuracy -- gliner-small
 *     npm run bench:accuracy -- gliner-small-32k
 */
import { readFileSync, statSync } from 'node:fs'
import {
  getLocalModel,
  getWindowStrategy,
  registerLocalModel,
  resetScheduler,
} from '../src/engine/confirm'
import { createGlinerConfirmer } from '../src/engine/confirm/gliner'
import { scanWithConfirmation } from '../src/engine/detect'
import { memorySink, registerMetricsSink } from '../src/engine/metrics'

const dir = process.argv[2] ?? 'gliner-small'
const modelFile = `public/models/${dir}/onnx/model.onnx`
let bytes = 0
try {
  bytes = statSync(modelFile).size
} catch {
  // Reported as missing below.
}

/** Several candidates per region — the only workload where merging applies. */
const DENSE = `Adeyemi confirmed the migration window this morning.
Christian joined the review and Mark reviewed the invoice afterwards.
Rose from the finance team called about the renewal.
Oyelaran Babatunde will pick up the handover from Thandeka Mokoena.
Chase from procurement signed off. Hyundai reported record sales.
Nokia Bell Labs published the paper. Grace approved the change.
May and August were both quiet. Faith raised the ticket with Miles.
Robin from legal reviewed it, then Hope escalated to Jordan.`

/**
 * Names outside every gazetteer. Vocabulary pruning taxes exactly these — a
 * rare name fragments into more subwords than an Anglo one — so they are the
 * first thing to check after any change to the tokenizer or the weights.
 */
const RARE: Array<[string, string]> = [
  ['Aarav Krishnamurthy confirmed the migration window.', 'Aarav Krishnamurthy'],
  ['Oyelaran Babatunde approved the change last night.', 'Oyelaran Babatunde'],
  ['Thandeka Mokoena raised the ticket this morning.', 'Thandeka Mokoena'],
  ['Chukwuemeka Okonjo signed the handover document.', 'Chukwuemeka Okonjo'],
  ['Kavita Radhakrishnan reviewed the incident report.', 'Kavita Radhakrishnan'],
  ['Nguyen Van Duc escalated the case to support.', 'Nguyen Van Duc'],
  ['Tariq Al-Mansoor completed the migration overnight.', 'Tariq Al-Mansoor'],
  ['Sarah Mitchell confirmed the migration window.', 'Sarah Mitchell'],
]

interface HeldOutCase {
  text: string
  value: string
  person: boolean
}

const sink = memorySink()
registerMetricsSink(sink)

registerLocalModel(
  createGlinerConfirmer({
    basePath: 'public/models',
    modelName: dir,
    modelFile,
    // Measured, not the default constant: a pruned artifact is much smaller,
    // and the gate and the metrics both read this.
    bytes: bytes || undefined,
  }),
)

if (!(await getLocalModel().isAvailable())) {
  console.error(
    `public/models/${dir}/onnx/model.onnx is missing.\n` +
      `Run \`npm run provision:model\`, and \`npm run provision:prune\` for a pruned artifact.`,
  )
  process.exit(1)
}

const loadStarted = performance.now()
await getLocalModel().load()
const loadMs = performance.now() - loadStarted

async function heldOutF1(file: string): Promise<string> {
  const cases: HeldOutCase[] = JSON.parse(readFileSync(file, 'utf8'))
  let tp = 0
  let fp = 0
  let fn = 0
  for (const testCase of cases) {
    resetScheduler()
    const result = await scanWithConfirmation(testCase.text, { phase: 'harness' })
    const found = result.findings.some(
      (f) =>
        f.category === 'PERSON' &&
        (f.value.toLowerCase().includes(testCase.value.toLowerCase()) ||
          testCase.value.toLowerCase().includes(f.value.toLowerCase())),
    )
    if (found && testCase.person) tp += 1
    if (found && !testCase.person) fp += 1
    if (!found && testCase.person) fn += 1
  }
  const precision = tp / Math.max(1, tp + fp)
  const recall = tp / Math.max(1, tp + fn)
  const f1 = (2 * precision * recall) / Math.max(1e-4, precision + recall)
  return `${(f1 * 100).toFixed(1)}%`
}

// Deliberately not overridden: the gate has to measure what ships. An earlier
// version forced merging on here, so it was scoring a configuration the
// product no longer uses.
const set1 = await heldOutF1('bench/heldout-ambiguity.json')
const set2 = await heldOutF1('bench/heldout-ambiguity-2.json')

const durations: number[] = []
let denseFindings = 0
let denseWindows = 0
for (let i = 0; i < 5; i++) {
  resetScheduler()
  sink.events.length = 0
  const result = await scanWithConfirmation(DENSE, { phase: 'harness' })
  const event = sink.events.find((e) => e.escalated)
  if (event) {
    durations.push(event.durationMs)
    denseWindows = event.windowCount
  }
  denseFindings = result.findings.length
}
durations.sort((a, b) => a - b)

let recalled = 0
const missed: string[] = []
for (const [text, value] of RARE) {
  resetScheduler()
  const result = await scanWithConfirmation(text, { phase: 'harness' })
  if (result.findings.some((f) => f.category === 'PERSON' && value.includes(f.value))) {
    recalled += 1
  } else {
    missed.push(value)
  }
}

const cost = getLocalModel().cost
console.log(`\nmodel            ${dir}`)
console.log(`payload          ${(cost.bytes / 1e6).toFixed(1)} MB on disk`)
console.log(`cold start       ${loadMs.toFixed(0)} ms`)
console.log(
  `windows          ${
    getWindowStrategy().merge
      ? `merged, cap ${getWindowStrategy().maxChars}`
      : 'one per candidate'
  }`,
)
console.log('─'.repeat(52))
console.log(`held-out set 1   ${set1}`)
console.log(`held-out set 2   ${set2}`)
console.log(
  `dense document   ${denseFindings} findings · ${denseWindows} window(s) · ` +
    `${(durations[Math.floor(durations.length / 2)] ?? 0).toFixed(0)} ms`,
)
console.log(`rare names       ${recalled}/${RARE.length}`)
if (missed.length) console.log(`  missed:        ${missed.join(', ')}`)
