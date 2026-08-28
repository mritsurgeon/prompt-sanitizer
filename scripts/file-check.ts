/**
 * Round-trips every sample file — `npm run check:files`.
 *
 * Runs exactly what the browser runs: extract text, scan it, sanitize it,
 * write a cleaned copy, then re-open that cleaned copy and scan it again.
 * The second scan is the real test — if anything sensitive survived the
 * rewrite, it shows up here.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from '../src/engine/detect'
import { sanitize } from '../src/engine/sanitize'
import { extractFile } from '../src/files/extract'
import { buildCleanedFile } from '../src/files/exportFile'

const samples = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples')

const toFile = (name: string) =>
  new File([readFileSync(join(samples, name))], name)

for (const name of [
  'support-cases.csv',
  'customer-contracts.xlsx',
  'incident-report.docx',
]) {
  const extracted = await extractFile(toFile(name))
  const before = scan(extracted.text, {
    meta: { filename: name, sheetNames: extracted.sheetNames },
    structuralDelimiter: extracted.structuralDelimiter,
  })

  const cleaned = sanitize(extracted.text, before.findings, { mode: 'redact' })
  const output = await buildCleanedFile(extracted, cleaned.text, cleaned.valueMap)

  const roundTripped = await extractFile(
    new File([await output.blob.arrayBuffer()], output.filename),
  )
  const after = scan(roundTripped.text, {
    structuralDelimiter: roundTripped.structuralDelimiter,
  })
  const ours = new Set(cleaned.replacements.map((r) => r.replacement))
  const leaked = after.findings.filter((f) => !ours.has(f.value))

  console.log(`\n=== ${name} (${extracted.detail}) ===`)
  console.log(
    `  before: ${before.risk.score} · ${before.findings.length} findings · document: ${before.document.state}`,
  )
  console.log(`  wrote:  ${output.filename} (${output.blob.size} bytes)`)
  console.log(`  after:  ${after.risk.score} · ${leaked.length} leaked`)

  if (leaked.length) {
    for (const f of leaked) console.log(`    LEAK ${f.category}: ${f.value}`)
  }
  console.log(
    `  cleaned text starts: ${JSON.stringify(roundTripped.text.slice(0, 160))}`,
  )
}
