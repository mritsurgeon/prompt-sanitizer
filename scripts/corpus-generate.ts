/**
 * Generates the labelled document corpus — `npm run corpus:generate`.
 *
 * Deterministic: one fixed seed, so two runs produce byte-identical output and
 * a score is comparable across engine changes. The output is git-ignored
 * rather than committed, because it is reproducible from the generator and
 * committing it would invite someone to hand-edit a case until it passes.
 *
 * Documents rather than sentences, at three densities. Density is the whole
 * point: a one-candidate document exercises no windowing, no merging and no
 * consistency pass, which is precisely why the existing sets could not see the
 * merge-cap regression.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  FAMILIES,
  FILLER,
  FRAMES,
  POOLS,
  type Frame,
  type Label,
} from '../bench/frames'

const OUT = 'bench/generated/documents.json'
const SEED = 0x5eed_1234

/** mulberry32 — small, fast and, above all, the same everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface CorpusSpan {
  value: string
  start: number
  end: number
  /** null means "must not be flagged" — a trap. */
  label: Label
  frameId: string
  family: string
}

export interface CorpusDocument {
  id: string
  text: string
  /** How many labelled slots it holds — the density band. */
  density: 'sparse' | 'medium' | 'dense'
  spans: CorpusSpan[]
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]+/g, '.')
    .replace(/^\.|\.$/g, '')

interface Sentence {
  text: string
  /** Offset of the slot value inside `text`. */
  offset: number
  value: string
  frame: Frame
}

function realise(frame: Frame, value: string): Sentence {
  const withEmail = frame.template.replace('{slug}', slugOf(value))
  const offset = withEmail.indexOf('{}')
  return {
    text: withEmail.replace('{}', value),
    offset,
    value,
    frame,
  }
}

/**
 * Rounds are tuned per band so the three contribute comparable numbers of
 * spans. Left to itself, one slot per document produces an order of magnitude
 * more sparse documents than dense ones — and the dense ones are the reason
 * this corpus exists, since they are the only shape that exercises windowing,
 * merging and the consistency pass.
 */
const DENSITIES: Array<{
  band: CorpusDocument['density']
  slots: number
  rounds: number
}> = [
  { band: 'sparse', slots: 1, rounds: 15 },
  { band: 'medium', slots: 4, rounds: 20 },
  { band: 'dense', slots: 9, rounds: 30 },
]

function generate(): CorpusDocument[] {
  const random = rng(SEED)
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]

  const documents: CorpusDocument[] = []
  let counter = 0

  // Every frame appears at every density, so a family is never confounded
  // with a density band.
  for (const { band, slots, rounds } of DENSITIES) {
    for (let round = 0; round < rounds; round++) {
      const shuffled = [...FRAMES].sort(() => random() - 0.5)

      for (let at = 0; at < shuffled.length; at += slots) {
        const chosen = shuffled.slice(at, at + slots)
        if (chosen.length < slots) break

        const sentences: Sentence[] = []
        // A value must not appear twice in one document with different
        // labels: the engine's entity-consistency pass will — correctly —
        // settle both on one reading, so a document that contradicts itself
        // measures the grouping rather than the engine.
        const used = new Set<string>()

        for (const frame of chosen) {
          const pool = POOLS[frame.pool]
          let value: string | null = null
          for (let attempt = 0; attempt < 12; attempt++) {
            const candidate = pick(pool)
            if (!used.has(candidate.toLowerCase())) {
              value = candidate
              break
            }
          }
          if (!value) continue
          used.add(value.toLowerCase())
          sentences.push(realise(frame, value))
        }
        if (!sentences.length) continue

        let text = ''
        const spans: CorpusSpan[] = []
        for (const [i, sentence] of sentences.entries()) {
          // Filler between slots, sometimes, so density varies within a band
          // and merging has both overlapping and separated runs to handle.
          if (i > 0 && random() < 0.4) text += `${pick(FILLER)} `
          const base = text.length
          text += sentence.text
          spans.push({
            value: sentence.value,
            start: base + sentence.offset,
            end: base + sentence.offset + sentence.value.length,
            label: sentence.frame.label,
            frameId: sentence.frame.id,
            family: sentence.frame.family,
          })
          text += i === sentences.length - 1 ? '' : '\n'
        }

        counter += 1
        documents.push({ id: `d${String(counter).padStart(4, '0')}`, text, density: band, spans })
      }
    }
  }

  return documents
}

const documents = generate()

// Assert the offsets before writing. A corpus whose spans do not point at their
// own values would silently score everything wrong.
for (const document of documents) {
  for (const span of document.spans) {
    if (document.text.slice(span.start, span.end) !== span.value) {
      throw new Error(
        `${document.id}: span ${span.frameId} does not point at ${JSON.stringify(span.value)}`,
      )
    }
  }
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(documents))

const spans = documents.flatMap((d) => d.spans)
const positives = spans.filter((s) => s.label !== null).length
console.log(`\nwrote ${OUT}`)
console.log(`  documents   ${documents.length}`)
console.log(`  spans       ${spans.length} (${positives} to find, ${spans.length - positives} traps)`)
console.log(`  families    ${FAMILIES.length}`)
for (const { band } of DENSITIES) {
  const inBand = documents.filter((d) => d.density === band)
  const perDoc = inBand.length
    ? (inBand.reduce((n, d) => n + d.spans.length, 0) / inBand.length).toFixed(1)
    : '0'
  console.log(`  ${band.padEnd(8)}    ${String(inBand.length).padStart(4)} documents · ${perDoc} spans each`)
}
