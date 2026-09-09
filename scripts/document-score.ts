/**
 * Scores the generated document corpus — `npm run check:documents`.
 *
 * The instrument the other two benchmarks could not be. `check:corpus` calls
 * the synchronous `scan()`, so it never escalates; the held-out ambiguity sets
 * are one sentence per case, so window merging never activates on them. Both
 * duly reported "no change" for a merge cap that loses three findings in
 * thirteen on a dense document.
 *
 * This runs `scanWithConfirmation` over multi-candidate documents, so
 * escalation, windowing, merging and the entity-consistency pass are all in
 * play — and it reports per density band, because a change that only hurts
 * dense documents is exactly the change the old benchmarks hid.
 *
 *   npm run check:documents
 *   npm run check:documents -- --gliner            # with the model
 *   npm run check:documents -- --no-merge          # windowing off
 *   npm run check:documents -- --cap 800           # a different merge cap
 *   npm run check:documents -- --limit 120         # a quick pass
 *   npm run check:documents -- --json              # for diffing two runs
 */
import { readFileSync } from 'node:fs'
import {
  getWindowStrategy,
  registerLocalModel,
  resetScheduler,
  setWindowStrategy,
} from '../src/engine/confirm'
import { createGlinerConfirmer } from '../src/engine/confirm/gliner'
import { scanWithConfirmation } from '../src/engine/detect'
import { memorySink, registerMetricsSink } from '../src/engine/metrics'
import { HELD_OUT_FAMILIES } from '../bench/frames'
import type { CorpusDocument } from './corpus-generate'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const value = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? null : args[at + 1]
}

const CORPUS = 'bench/generated/documents.json'
let documents: CorpusDocument[]
try {
  documents = JSON.parse(readFileSync(CORPUS, 'utf8'))
} catch {
  console.error(`${CORPUS} is missing — run \`npm run corpus:generate\` first.`)
  process.exit(1)
}

// Documents are emitted sparse-first, so `--limit` alone only ever sees the
// easy band. `--density dense` is how you aim at the shape that actually
// exercises windowing.
const density = value('density')
if (density) documents = documents.filter((d) => d.density === density)

const limit = Number(value('limit') ?? 0)
if (limit > 0) documents = documents.slice(0, limit)

if (flag('gliner')) {
  registerLocalModel(
    createGlinerConfirmer({
      basePath: 'public/models',
      modelName: value('model') ?? 'gliner-small-32k',
      modelFile: `public/models/${value('model') ?? 'gliner-small-32k'}/onnx/model.onnx`,
    }),
  )
}
setWindowStrategy({
  merge: !flag('no-merge'),
  ...(value('cap') ? { maxChars: Number(value('cap')) } : {}),
})

const sink = memorySink()
registerMetricsSink(sink)

const ENTITY = new Set(['PERSON', 'ORGANISATION', 'LOCATION'])

interface Tally {
  /** Positives the engine flagged as an entity of any kind. */
  detected: number
  /** Of those, the ones it also labelled correctly. */
  labelled: number
  /** Positives it missed entirely. */
  missed: number
  /** Traps it flagged. */
  traps: number
  /** Traps it correctly left alone. */
  clean: number
}

const empty = (): Tally => ({ detected: 0, labelled: 0, missed: 0, traps: 0, clean: 0 })
const add = (into: Tally, from: Tally) => {
  into.detected += from.detected
  into.labelled += from.labelled
  into.missed += from.missed
  into.traps += from.traps
  into.clean += from.clean
}

const overall = empty()
const byDensity = new Map<string, Tally>()
const byFamily = new Map<string, Tally>()
const heldOut = empty()
const seen = empty()

const started = performance.now()

for (const document of documents) {
  resetScheduler()
  const result = await scanWithConfirmation(document.text, { phase: 'harness' })

  for (const span of document.spans) {
    // Matched by position, never by value substring. A multi-candidate
    // document makes substring matching credit one span for another's finding,
    // which is how a benchmark reports a score it has not measured.
    const hit = result.findings.find(
      (f) => ENTITY.has(f.category) && f.start < span.end && f.end > span.start,
    )

    const tally = empty()
    if (span.label === null) {
      if (hit) tally.traps = 1
      else tally.clean = 1
    } else if (!hit) {
      tally.missed = 1
    } else {
      tally.detected = 1
      // A wrong label is a category error, not a leak — the value is still
      // found and still redacted — so the two are counted apart rather than
      // collapsed into one number that hides which happened.
      if (hit.category === span.label) tally.labelled = 1
    }

    const into = (map: Map<string, Tally>, key: string) => {
      const existing = map.get(key)
      if (existing) return existing
      const fresh = empty()
      map.set(key, fresh)
      return fresh
    }

    add(overall, tally)
    add(into(byDensity, document.density), tally)
    add(into(byFamily, span.family), tally)
    add(HELD_OUT_FAMILIES.includes(span.family) ? heldOut : seen, tally)
  }
}

const elapsed = performance.now() - started

function report(name: string, t: Tally) {
  const positives = t.detected + t.missed
  const recall = positives ? t.detected / positives : 0
  const labelAcc = t.detected ? t.labelled / t.detected : 0
  const precision = t.detected + t.traps ? t.detected / (t.detected + t.traps) : 0
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  const trapRate = t.traps + t.clean ? t.traps / (t.traps + t.clean) : 0
  // A trap-only family has no positives, so recall and F1 are undefined for
  // it. Printing 0.0% there reads as total failure when the family is in fact
  // passing perfectly — the only number that means anything is the trap rate.
  const pct = (n: number, defined: boolean) => (defined ? `${(n * 100).toFixed(1)}%` : '—')
  const hasPositives = positives > 0
  const hasTraps = t.traps + t.clean > 0

  return {
    name,
    positives,
    traps: t.traps + t.clean,
    recall,
    precision,
    f1,
    labelAcc,
    trapRate,
    line:
      name.padEnd(22) +
      String(positives).padStart(6) +
      String(t.traps + t.clean).padStart(7) +
      pct(recall, hasPositives).padStart(9) +
      pct(precision, hasPositives).padStart(11) +
      pct(f1, hasPositives).padStart(8) +
      pct(labelAcc, t.detected > 0).padStart(9) +
      pct(trapRate, hasTraps).padStart(10),
  }
}

const strategy = getWindowStrategy()
const escalated = sink.events.filter((e) => e.escalated)

if (flag('json')) {
  console.log(
    JSON.stringify(
      {
        documents: documents.length,
        overall: report('overall', overall),
        density: [...byDensity].map(([k, v]) => report(k, v)),
        family: [...byFamily].map(([k, v]) => report(k, v)),
      },
      null,
      1,
    ),
  )
} else {
  console.log(`\ndocuments  ${documents.length} · ${overall.detected + overall.missed} to find · ${overall.traps + overall.clean} traps`)
  console.log(`windows    ${strategy.merge ? `merged, cap ${strategy.maxChars}` : 'one per candidate'}`)
  console.log(`escalated  ${escalated.length} documents · ${escalated.reduce((n, e) => n + e.windowCount, 0)} windows`)
  console.log(`elapsed    ${(elapsed / 1000).toFixed(1)} s\n`)

  const header =
    'slice'.padEnd(22) + 'find'.padStart(6) + 'traps'.padStart(7) +
    'recall'.padStart(9) + 'precision'.padStart(11) + 'F1'.padStart(8) +
    'label'.padStart(9) + 'sprung'.padStart(10)
  console.log(header)
  console.log('─'.repeat(header.length))
  console.log(report('OVERALL', overall).line)
  console.log('─'.repeat(header.length))
  for (const band of ['sparse', 'medium', 'dense']) {
    const tally = byDensity.get(band)
    if (tally) console.log(report(band, tally).line)
  }
  console.log('─'.repeat(header.length))
  console.log(report('tuning families', seen).line)
  console.log(report('held-out families', heldOut).line)
  console.log('─'.repeat(header.length))
  for (const [family, tally] of [...byFamily].sort()) {
    const mark = HELD_OUT_FAMILIES.includes(family) ? '*' : ' '
    console.log(report(`${mark}${family}`, tally).line)
  }
  console.log(`\n* held out for validation. "label" is how often a detected value`)
  console.log(`  also got the right category — a wrong one is a category error,`)
  console.log(`  not a leak, since the value is still found and still redacted.`)
}
