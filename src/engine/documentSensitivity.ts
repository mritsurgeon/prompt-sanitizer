import {
  CONFIDENTIAL_FILENAME_RE,
  CONFIDENTIAL_MARKER_RE,
  CONFIDENTIAL_SECTION_RE,
  CONFIDENTIAL_TOPICS,
  FILENAME_MARKER_RE,
  PUBLIC_MARKER_RE,
} from './lexicon'
import type { DocumentClassification } from './classify'
import { SENSITIVE_DOCUMENT_TYPES, SENSITIVE_TOPICS } from './taxonomy'
import type {
  Candidate,
  DocumentMeta,
  DocumentSensitivity,
  SensitivityState,
  Signal,
} from './types'

/**
 * Only the category and value are needed, so both candidates and finished
 * findings can be passed in.
 */
type Detected = Pick<Candidate, 'category' | 'value'>

/**
 * The document sensitivity engine.
 *
 * Answers a question the PII detectors cannot: "even with no personal data in
 * it at all, is this something that should stay inside the company?" A Q4
 * roadmap with no names in it is exactly the case that matters.
 *
 * Three rules keep it honest:
 *
 *  1. It is never keyword-only. At least two *independent families* of signal
 *     must fire before the state can rise above "general", so a document that
 *     merely contains the word "confidential" is not classified as
 *     confidential.
 *  2. It looks for contrary evidence. Press-release and public-policy language
 *     pushes the score back down.
 *  3. It never claims certainty. The strongest thing it says is "potential",
 *     because it cannot know the organisation's real classification policy.
 */

/** Above this, treat as potentially company confidential. */
export const SENSITIVE_THRESHOLD = 0.65
/** Above this, treat as possibly internal. */
export const INTERNAL_THRESHOLD = 0.35
/** Fewer than this many independent signal families means "general", always. */
export const MIN_SIGNAL_FAMILIES = 2
/**
 * ...unless one family is on its own overwhelming. Six distinct architecture
 * terms is not a stray keyword, it is a document about internal architecture.
 */
export const STRONG_FAMILY_TERMS = 3

const signal = (id: string, weight: number, note: string): Signal => ({
  id,
  weight,
  note,
})

/** Short, un-punctuated lines read as headings — including our sheet markers. */
function extractHeadings(text: string): string[] {
  const headings: string[] = []
  for (const line of text.split('\n').slice(0, 400)) {
    const trimmed = line.trim().replace(/^-{2,}\s*|\s*-{2,}$/g, '').trim()
    if (!trimmed || trimmed.length > 80) continue
    if (/[.!?,;]$/.test(trimmed)) continue
    const isMarkdown = /^#{1,6}\s/.test(line)
    const isUpper = trimmed === trimmed.toUpperCase() && /[A-Z]{3}/.test(trimmed)
    const isTitleish = /^(?:[A-Z][\w'&/-]*)(?:\s+(?:[A-Z][\w'&/-]*|of|and|for|the|to|in))*$/.test(trimmed)
    if (isMarkdown || isUpper || isTitleish) {
      headings.push(trimmed.replace(/^#{1,6}\s*/, ''))
    }
  }
  return headings
}

const ROADMAP_ROW_RE =
  /\b(?:Q[1-4]|H[12])\s*(?:FY)?\s*'?\d{2,4}\b|\b(?:20\d{2})\s*(?:target|plan|release|ga)\b/i

function countDistinct(haystack: string, terms: string[]): string[] {
  const found: string[] = []
  for (const term of terms) {
    if (haystack.includes(term)) found.push(term)
  }
  return found
}

export function assessDocument(
  text: string,
  meta: DocumentMeta = {},
  candidates: Detected[] = [],
  classification?: DocumentClassification,
): DocumentSensitivity {
  const lower = text.toLowerCase()
  const signals: Signal[] = []
  const families = new Set<string>()
  const topicLabels: string[] = []
  let strongFamilies = 0

  // ---- 1. explicit classification markers --------------------------------
  const markers = text.match(CONFIDENTIAL_MARKER_RE)
  if (markers?.length) {
    signals.push(
      signal(
        'marker',
        0.35,
        `Marked "${markers[0].trim()}" in the content itself`,
      ),
    )
    families.add('markers')
  }

  // ---- 2. semantic topic signals -----------------------------------------
  for (const topic of CONFIDENTIAL_TOPICS) {
    const hits = countDistinct(lower, topic.terms)
    if (!hits.length) continue

    // One passing mention is weak; several distinct terms from the same family
    // means the document is actually about that subject.
    const weight =
      hits.length >= STRONG_FAMILY_TERMS ? 0.35 : hits.length >= 2 ? 0.25 : 0.12
    signals.push(
      signal(
        `topic:${topic.id}`,
        weight,
        `Discusses ${topic.label} (${hits.slice(0, 3).join(', ')})`,
      ),
    )
    if (hits.length >= 2) {
      families.add(`topic:${topic.id}`)
      topicLabels.push(topic.label)
    }
    if (hits.length >= STRONG_FAMILY_TERMS) strongFamilies += 1
  }

  // ---- 3. metadata: filename, sheet names, headings ----------------------
  // A classification word in the filename is somebody deliberately labelling
  // the file, so it counts as a marker. A topic word in the filename is a
  // weaker, separate hint. A file needs more than one of these to be
  // classified, so "internal.txt" alone still comes back general.
  if (meta.filename) {
    const marker = meta.filename.match(FILENAME_MARKER_RE)
    if (marker) {
      signals.push(
        signal(
          'filename-marker',
          0.3,
          `Whoever saved this named the file "${marker[0]}"`,
        ),
      )
      families.add('markers')
    }
    if (CONFIDENTIAL_FILENAME_RE.test(meta.filename)) {
      signals.push(
        signal('filename', 0.2, `The file name itself says "${meta.filename}"`),
      )
      families.add('metadata')
    }
  }

  const structureNames = [...(meta.sheetNames ?? []), ...(meta.headings ?? [])]
  const headings = meta.headings?.length ? meta.headings : extractHeadings(text)
  const namedSignals = [...structureNames, ...headings].filter((name) =>
    CONFIDENTIAL_SECTION_RE.test(name),
  )
  if (namedSignals.length) {
    signals.push(
      signal(
        'heading',
        0.15,
        `Section or sheet named "${namedSignals[0]}"`,
      ),
    )
    families.add('metadata')
  }

  // ---- 4. structural signals ---------------------------------------------
  const identifierCount = candidates.filter((c) =>
    ['CUSTOMER_ID', 'CASE_ID', 'CONTRACT_ID', 'EMPLOYEE_ID'].includes(c.category),
  ).length
  if (identifierCount >= 5) {
    signals.push(
      signal(
        'identifier-table',
        0.2,
        `Contains ${identifierCount} customer or contract references — reads like an internal list`,
      ),
    )
    families.add('structure')
  }

  const orgCount = new Set(
    candidates.filter((c) => c.category === 'ORGANISATION').map((c) => c.value),
  ).size
  if (orgCount >= 3) {
    signals.push(
      signal(
        'customer-list',
        0.12,
        `Names ${orgCount} different companies — possibly a customer list`,
      ),
    )
    families.add('structure')
  }

  const roadmapRows = text
    .split('\n')
    .filter((line) => ROADMAP_ROW_RE.test(line)).length
  if (roadmapRows >= 3) {
    signals.push(
      signal(
        'roadmap-rows',
        0.18,
        `${roadmapRows} lines carry future quarters or target dates`,
      ),
    )
    families.add('structure')
  }

  // ---- 5. what kind of document this is ----------------------------------
  // An NDA or a signed contract is internal by nature, whatever vocabulary it
  // happens to use. This is an independent judgement (see classify.ts), so it
  // counts as its own family.
  if (classification) {
    const type = classification.documentType
    if (type && SENSITIVE_DOCUMENT_TYPES.has(type.id)) {
      // A document that unmistakably announces itself as an NDA, a contract or
      // a statement of work is internal by its nature, whatever vocabulary it
      // happens to use — so a confident identification counts on its own.
      const emphatic = type.confidence >= 0.8
      signals.push(
        signal(
          `type:${type.id}`,
          emphatic ? 0.4 : 0.25,
          `Reads like ${/^[aeiou]/i.test(type.label) ? 'an' : 'a'} ${type.label.toLowerCase()}`,
        ),
      )
      families.add('document-type')
      if (emphatic) strongFamilies += 1
    }

    const sensitiveTopic = classification.topics.find((t) =>
      SENSITIVE_TOPICS.has(t.id),
    )
    if (sensitiveTopic) {
      signals.push(
        signal(
          `subject:${sensitiveTopic.id}`,
          0.15,
          `The subject is ${sensitiveTopic.label.toLowerCase()}`,
        ),
      )
      families.add('subject')
    }
  }

  // ---- 6. contrary evidence ----------------------------------------------
  const publicMarkers = text.match(PUBLIC_MARKER_RE)
  if (publicMarkers?.length) {
    signals.push(
      signal(
        'public-language',
        -0.35,
        `Reads as already-public material ("${publicMarkers[0].trim()}")`,
      ),
    )
  }

  // ---- combine -----------------------------------------------------------
  const raw = signals.reduce((sum, s) => sum + s.weight, 0)
  let confidence = Math.max(0, Math.min(1, raw))

  // The keyword-only guard: a single stray keyword is never enough. Either two
  // independent families must agree, or one family must be emphatic.
  if (families.size < MIN_SIGNAL_FAMILIES && strongFamilies === 0) {
    confidence = Math.min(confidence, INTERNAL_THRESHOLD - 0.01)
  }

  let state: SensitivityState = 'general'
  if (confidence >= SENSITIVE_THRESHOLD) state = 'sensitive'
  else if (confidence >= INTERNAL_THRESHOLD) state = 'internal'

  const HEADLINES: Record<SensitivityState, string> = {
    general: 'Nothing suggests this is internal-only',
    internal: 'Possibly internal information',
    sensitive: 'Potential company confidential information',
  }

  const named = topicLabels.slice(0, 3)
  const summary =
    state === 'general'
      ? 'We found no signs that this is meant to stay inside the company.'
      : named.length
        ? `This looks like it covers ${named.join(', ')} — worth a second thought before sharing it with an AI tool.`
        : 'Several signals suggest this is meant for internal use.'

  return {
    state,
    confidence,
    headline: HEADLINES[state],
    summary,
    signals,
    topics: [...families],
  }
}
