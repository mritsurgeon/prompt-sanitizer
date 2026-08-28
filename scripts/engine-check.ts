/**
 * Smoke test for the detection engine — `npm run check:engine`.
 *
 * Prints what each layer finds on the demo prompt, the score before and after
 * cleaning in all three modes, the improved prompt, and a false-positive
 * sample that should come back almost empty.
 */
import { scan } from '../src/engine/detect'
import { computeRisk } from '../src/engine/risk'
import { sanitize } from '../src/engine/sanitize'
import { improvePrompt } from '../src/engine/improve'
import { DEMO_PROMPT } from '../src/demo/samples'
import type { SanitizeMode } from '../src/engine/types'

function report(label: string, text: string) {
  const result = scan(text)
  console.log(`\n=== ${label} — ${result.durationMs.toFixed(2)}ms ===`)
  console.log(`score ${result.risk.score} (${result.risk.level})`, result.risk.counts)
  console.log(
    `document: ${result.document.state} — ${result.document.headline}` +
      (result.ambiguous.length ? ` · ${result.ambiguous.length} ambiguous` : ''),
  )
  for (const f of result.findings) {
    console.log(
      `  ${f.category.padEnd(18)} ${JSON.stringify(f.value).padEnd(48)} ${f.confidence.toFixed(2)} ${f.tier.padEnd(6)} ${f.rule}`,
    )
  }
  return result
}

const demo = report('DEMO PROMPT', DEMO_PROMPT)

for (const mode of ['redact', 'pseudonymize', 'synthetic'] as SanitizeMode[]) {
  const cleaned = sanitize(DEMO_PROMPT, demo.findings, { mode })
  const ours = new Set(cleaned.replacements.map((r) => r.replacement))
  const residual = scan(cleaned.text).findings.filter((f) => !ours.has(f.value))
  console.log(
    `\n--- ${mode}: ${demo.risk.score} -> ${computeRisk(residual).score}`,
  )
  console.log(cleaned.text)
  if (residual.length) {
    console.log(
      'residual:',
      residual.map((r) => `${r.category}:${r.value}`).join(', '),
    )
  }
}

console.log('\n=== IMPROVED (from the cleaned demo) ===')
console.log(
  improvePrompt(sanitize(DEMO_PROMPT, demo.findings, { mode: 'redact' }).text)
    .text,
)

console.log('\n=== IMPROVED (short prompt) ===')
console.log(improvePrompt('why did this backup fail and what should I check').text)

report(
  'FALSE POSITIVES — should be near empty',
  `The meeting is on 2024-03-15 at 14:30 and version 12.1.2.4 shipped.
We processed 1 234 567 records this quarter. Please review the SQL query and the API response.
Follow-up on the day-to-day work and the sign-off process. Total cost was 45 000 000.
See the attached report for details.`,
)

report(
  'MIXED REAL-WORLD SAMPLE',
  `Dear Mr Patel, your order PO-88213 has shipped. Card 4111 1111 1111 1111 was charged.
Login: admin, password = Summer2024! on \\\\FS-CORP-02\\finance.
Contact Priya Naidoo at priya.naidoo@example.com or 011 555 0142.
Server web-prod-03.acme.local at 192.168.4.21. Employee EMP-88213. Project Falcon stays confidential.`,
)
