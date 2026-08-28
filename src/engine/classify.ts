import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_TO_TOPIC,
  FILENAME_HINTS,
  FUNCTIONS,
  TOPICS,
  TOPIC_TO_FUNCTION,
  type ClassDefinition,
  type Dimension,
} from './taxonomy'
import type { DocumentMeta } from './types'

/**
 * Document classification across three dimensions: subject, document type and
 * owning function.
 *
 * This is a separate question again from "does it contain PII?" and from "is it
 * company confidential?" — a signed NDA has no PII in it, is obviously
 * internal, and knowing it is *an NDA owned by Legal* is what tells a person
 * how careful to be.
 *
 * Deterministic and weighted, in the same shape as the rest of the engine:
 * canonical signatures carry most of the weight, supporting vocabulary
 * contributes in aggregate, and neighbouring classes can argue against each
 * other so "Statement of work" does not simply read as "Contract".
 *
 * A zero-shot NLI classifier would plug in behind `ClassifierBackend` below.
 * See the README for the measured comparison.
 */

/** Below this a label is not worth showing. */
export const CLASS_THRESHOLD = 0.45

const WEIGHT = {
  pattern: 0.5,
  strong: 0.3,
  term: 0.08,
  against: -0.35,
  filename: 0.3,
}

export interface Classification {
  dimension: Dimension
  id: string
  label: string
  confidence: number
  /** Plain-English evidence, for the same reason findings carry signals. */
  evidence: string[]
  /** True when derived from the subject rather than observed directly. */
  inferred?: boolean
}

export interface DocumentClassification {
  /** Multi-label: a document can be about several things at once. */
  topics: Classification[]
  /** Single best answer — a document is one kind of thing. */
  documentType: Classification | null
  /** Multi-label: more than one department can own something. */
  functions: Classification[]
  /** One line summarising all three, for the UI. */
  summary: string
}

const curve = (raw: number) => (raw <= 0 ? 0 : 1 - Math.exp(-raw / 0.8))

/** Count distinct hits so a single word repeated 50 times is not 50 signals. */
function scoreClass(
  definition: ClassDefinition,
  text: string,
  lower: string,
  filename?: string,
): { raw: number; evidence: string[] } {
  const evidence: string[] = []
  let raw = 0

  for (const pattern of definition.patterns ?? []) {
    const match = text.match(pattern)
    if (match) {
      raw += WEIGHT.pattern
      evidence.push(`says "${match[0].trim().slice(0, 40)}"`)
    }
  }

  const strongHits = (definition.strong ?? []).filter((s) => lower.includes(s))
  if (strongHits.length) {
    raw += WEIGHT.strong * Math.min(strongHits.length, 3)
    evidence.push(`mentions ${strongHits.slice(0, 3).join(', ')}`)
  }

  const termHits = (definition.terms ?? []).filter((t) => lower.includes(t))
  if (termHits.length) {
    raw += WEIGHT.term * Math.min(termHits.length, 6)
    if (!strongHits.length) {
      evidence.push(`uses ${termHits.slice(0, 3).join(', ')}`)
    }
  }

  for (const term of definition.against ?? []) {
    if (lower.includes(term)) raw += WEIGHT.against
  }

  const hint = FILENAME_HINTS[definition.id]
  if (filename && hint?.test(filename)) {
    raw += WEIGHT.filename
    evidence.push('the file name matches')
  }

  return { raw, evidence }
}

function classifyDimension(
  definitions: ClassDefinition[],
  text: string,
  lower: string,
  filename?: string,
): Classification[] {
  return definitions
    .map((definition) => {
      const { raw, evidence } = scoreClass(definition, text, lower, filename)
      return {
        dimension: definition.dimension,
        id: definition.id,
        label: definition.label,
        confidence: curve(raw),
        evidence,
      }
    })
    .filter((c) => c.confidence >= CLASS_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)
}

export function classifyDocument(
  text: string,
  meta: DocumentMeta = {},
): DocumentClassification {
  // Classification is about the document as a whole, and the opening is where
  // its identity lives — a contract announces itself in the first paragraph.
  // Capping the window also keeps this O(1) on a large file.
  const sample = text.slice(0, 20_000)
  const lower = sample.toLowerCase()
  const filename = [meta.filename, ...(meta.sheetNames ?? [])]
    .filter(Boolean)
    .join(' ')

  const topics = classifyDimension(TOPICS, sample, lower, filename).slice(0, 3)
  const types = classifyDimension(DOCUMENT_TYPES, sample, lower, filename)
  const documentType = types[0] ?? null

  // No subject vocabulary, but we know what kind of document it is — which
  // implies the subject. An invoice is about finance whether or not it ever
  // says so.
  if (!topics.length && documentType) {
    const mapped = DOCUMENT_TYPE_TO_TOPIC[documentType.id]
    const definition = TOPICS.find((t) => t.id === mapped)
    if (definition) {
      topics.push({
        dimension: 'topic',
        id: definition.id,
        label: definition.label,
        confidence: documentType.confidence * 0.7,
        evidence: [
          `inferred from the document type (${documentType.label.toLowerCase()})`,
        ],
        inferred: true,
      })
    }
  }

  const functions = classifyDimension(FUNCTIONS, sample, lower, filename).slice(
    0,
    2,
  )

  // Nobody named a department, but the subject is clear enough to attribute it.
  if (!functions.length && topics.length) {
    const mapped = TOPIC_TO_FUNCTION[topics[0].id]
    const definition = FUNCTIONS.find((f) => f.id === mapped)
    if (definition) {
      functions.push({
        dimension: 'function',
        id: definition.id,
        label: definition.label,
        confidence: topics[0].confidence * 0.65,
        evidence: [`inferred from the subject (${topics[0].label.toLowerCase()})`],
        inferred: true,
      })
    }
  }

  const parts: string[] = []
  if (documentType) parts.push(documentType.label)
  if (topics.length) parts.push(topics.map((t) => t.label).join(' and '))
  if (functions.length) parts.push(`${functions[0].label} area`)

  return {
    topics,
    documentType,
    functions,
    summary: parts.length ? parts.join(' · ') : 'No clear document type',
  }
}

// ---------------------------------------------------------------------------
// The seam for a model-based classifier.
// ---------------------------------------------------------------------------

/**
 * A zero-shot backend (DeBERTa-v3 / BART-MNLI) would implement this and be
 * registered at startup. Deliberately document-level and batched: one call
 * classifies one document across all three dimensions, because NLI zero-shot
 * costs one forward pass *per candidate label* and that only stays affordable
 * if it happens once per document rather than once per candidate.
 */
export interface ClassifierBackend {
  id: string
  label: string
  cost: { bytes: number; startupMs: number | null; perDocumentMs: number | null }
  isAvailable(): Promise<boolean>
  load(): Promise<void>
  classify(
    text: string,
    labels: { id: string; label: string; dimension: Dimension }[],
  ): Promise<{ id: string; score: number }[]>
  readonly loaded: boolean
}

let backend: ClassifierBackend | null = null

export function registerClassifier(next: ClassifierBackend | null): void {
  backend = next
}

export function getClassifier(): ClassifierBackend | null {
  return backend
}

/** Every label the taxonomy knows, in the shape a zero-shot backend wants. */
export function allLabels() {
  return [...TOPICS, ...DOCUMENT_TYPES, ...FUNCTIONS].map((d) => ({
    id: d.id,
    label: d.label,
    dimension: d.dimension,
  }))
}
