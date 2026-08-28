/**
 * Scores the detection engine against the labelled corpus —
 * `npm run check:corpus`.
 *
 * Prints false positives (things flagged that are ordinary language) and false
 * negatives (things missed that matter), so the effect of a rule change is a
 * number rather than an opinion.
 */
import { scan } from '../src/engine/detect'
import { ALL_CASES } from '../src/engine/__tests__/corpus'

let falsePositives = 0
let falseNegatives = 0
let truePositives = 0
let rejectChecks = 0

for (const { group, cases } of ALL_CASES) {
  const lines: string[] = []

  for (const testCase of cases) {
    const findings = scan(testCase.text).findings

    for (const reject of testCase.reject ?? []) {
      rejectChecks += 1
      const hit = findings.find(
        (f) => f.value === reject || f.value.includes(reject),
      )
      if (hit) {
        falsePositives += 1
        lines.push(
          `    FP  ${testCase.name}: flagged ${JSON.stringify(hit.value)} as ${hit.category} (${hit.rule})`,
        )
      }
    }

    for (const wanted of testCase.expect ?? []) {
      const hit = findings.find(
        (f) =>
          f.value === wanted.value &&
          (!wanted.category || f.category === wanted.category),
      )
      if (hit) {
        truePositives += 1
      } else {
        falseNegatives += 1
        const near = findings.find((f) => f.value.includes(wanted.value))
        lines.push(
          `    FN  ${testCase.name}: missed ${JSON.stringify(wanted.value)}` +
            (wanted.category ? ` as ${wanted.category}` : '') +
            (near ? ` (saw ${JSON.stringify(near.value)} as ${near.category})` : ''),
        )
      }
    }
  }

  console.log(`\n  ${group}`)
  console.log(lines.length ? lines.join('\n') : '    all clear')
}

const expectedTotal = truePositives + falseNegatives

console.log('\n─────────────────────────────────────────')
console.log(`  false positives   ${falsePositives} / ${rejectChecks} traps`)
console.log(`  false negatives   ${falseNegatives} / ${expectedTotal} expected`)
console.log(
  `  recall            ${((truePositives / expectedTotal) * 100).toFixed(1)}%`,
)
console.log(
  `  trap resistance   ${(((rejectChecks - falsePositives) / rejectChecks) * 100).toFixed(1)}%`,
)
console.log('─────────────────────────────────────────')
