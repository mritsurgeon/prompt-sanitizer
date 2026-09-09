/**
 * Shared types for the local detection / sanitization engine.
 *
 * Everything in `src/engine` is pure, synchronous and dependency-free so it can
 * run in the browser (or a worker, or Node) without any network access.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low'

/** Plain-English buckets we show to the user. No jargon leaks into the UI. */
export type Group = 'personal' | 'internal' | 'confidential' | 'secret'

export type CategoryId =
  // --- personal -----------------------------------------------------------
  | 'PERSON'
  | 'EMAIL'
  | 'PHONE'
  | 'NATIONAL_ID'
  | 'CREDIT_CARD'
  | 'BANK_ACCOUNT'
  | 'POSTAL_ADDRESS'
  | 'LOCATION'
  | 'ORGANISATION'
  // --- internal / business ------------------------------------------------
  | 'INTERNAL_HOST'
  | 'IP_ADDRESS'
  | 'MAC_ADDRESS'
  | 'NETWORK_PATH'
  | 'URL'
  | 'CUSTOMER_ID'
  | 'CASE_ID'
  | 'CONTRACT_ID'
  | 'EMPLOYEE_ID'
  | 'LICENSE_KEY'
  | 'REFERENCE_ID'
  | 'UUID'
  // --- company confidential / IP ------------------------------------------
  | 'PROJECT_CODE'
  | 'RELEASE_PLAN'
  | 'PRICING_TERM'
  // --- secrets ------------------------------------------------------------
  | 'API_KEY'
  | 'PASSWORD'
  | 'ACCESS_TOKEN'
  | 'PRIVATE_KEY'
  | 'CONNECTION_STRING'

export type DetectorLayer = 'pattern' | 'entity' | 'business' | 'confidential'

/** How sure the engine is, after context has been taken into account. */
export type Tier = 'high' | 'medium' | 'low'

export interface Category {
  id: CategoryId
  /** Plain-English name shown in the UI, e.g. "Person's name". */
  label: string
  group: Group
  severity: Severity
  /** Placeholder used in Redact mode, e.g. `[EMAIL]`. */
  token: string
  /** Prefix used in Pseudonymize mode, e.g. `Person_001`. */
  pseudoPrefix: string
  /** One line of plain-English justification shown in "View details". */
  why: string
  /**
   * Higher wins when two detectors claim overlapping text.
   * Secrets > structured identifiers > business IDs > names > locations.
   */
  priority: number
}

/**
 * One piece of evidence for or against a candidate. Signals are what make the
 * engine explainable: the same list drives the score and the "why" text.
 */
export interface Signal {
  id: string
  /** Positive supports the classification, negative argues against it. */
  weight: number
  /** Plain English, safe to show a non-technical user. */
  note: string
}

/**
 * What a detector emits. `base` is evidence from the detector alone; the
 * context engine then adds signals to reach a final confidence.
 */
export interface Candidate {
  category: CategoryId
  value: string
  start: number
  end: number
  layer: DetectorLayer
  /** Human-readable rule name, for explainability. */
  rule: string
  /** Detector-only evidence, 0..1, before any context is considered. */
  base: number
  /** Signals the detector already knows about. */
  signals?: Signal[]
  /**
   * The surface form is inherently ambiguous — a word that is both a name and
   * ordinary English, or a capitalised token no gazetteer recognises. These
   * need corroboration from context before they are believed.
   */
  ambiguous?: boolean
  /** No gazetteer recognised this; it is a candidate purely from shape. */
  unresolved?: boolean
  /** Single-token candidates are held to a stricter standard. */
  singleToken?: boolean
}

export interface Finding {
  id: string
  category: CategoryId
  /** The exact text that was matched. */
  value: string
  /** Character offsets into the scanned text. */
  start: number
  end: number
  /** 0..1 — how sure the engine is once context has been applied. */
  confidence: number
  tier: Tier
  layer: DetectorLayer
  /** Human-readable rule name, for explainability. */
  rule: string
  /** The evidence, for and against. Drives the UI explanation. */
  signals: Signal[]
  /** Users can switch an individual finding off before cleaning. */
  enabled: boolean
  /** Set when a second-stage confirmer resolved this finding. */
  confirmedBy?: string
}

export interface RiskCounts {
  personal: number
  internal: number
  confidential: number
  secret: number
  total: number
}

export type RiskLevel = 'safe' | 'low' | 'moderate' | 'high'

export interface RiskSummary {
  score: number
  level: RiskLevel
  counts: RiskCounts
}

// ---------------------------------------------------------------------------
// Document-level sensitivity — a different question from "is this PII?".
// ---------------------------------------------------------------------------

/**
 * Deliberately conservative. We cannot know an organisation's actual
 * classification policy, so the strongest thing we ever say is "potential".
 */
export type SensitivityState = 'general' | 'internal' | 'sensitive'

export interface DocumentSensitivity {
  state: SensitivityState
  confidence: number
  /** Headline shown to the user, e.g. "Potential company confidential information". */
  headline: string
  /** One plain-English sentence naming what drove the assessment. */
  summary: string
  signals: Signal[]
  /** Distinct signal families that fired. Used to refuse keyword-only calls. */
  topics: string[]
}

export interface DocumentMeta {
  filename?: string
  /** Worksheet names, for spreadsheets. */
  sheetNames?: string[]
  /** Detected headings, for documents. */
  headings?: string[]
}

export type SanitizeMode = 'redact' | 'pseudonymize' | 'synthetic'

export interface Replacement {
  finding: Finding
  replacement: string
  /** Offsets of the replacement inside the sanitized text. */
  start: number
  end: number
}

/**
 * Stand-in assignments, carried between sanitizations.
 *
 * A multi-turn conversation has to reuse its stand-ins: if turn one mapped
 * `Jane Doe` to `Person_001`, turn two must say `Person_001` again or the model
 * loses track of who is who — which is the whole reason nickname mode exists.
 * Carrying the counters matters as much as carrying the assignments: without
 * them, turn two starts counting at one again and a second person is handed a
 * stand-in that already belongs to somebody.
 */
export interface Pseudonyms {
  /** `${category}::${normalised value}` -> stand-in. */
  assigned: Map<string, string>
  /** Every stand-in handed out, so a synthetic one never collides. */
  used: Set<string>
  /** Next index per category, for nickname mode. */
  counters: Map<CategoryId, number>
}

export interface SanitizeResult {
  text: string
  replacements: Replacement[]
  /** original value -> replacement. Used to rewrite files cell-by-cell. */
  valueMap: Map<string, string>
  /**
   * The assignments after this pass, for the caller to hand back on the next
   * one. A fresh object each time rather than the input mutated, so a caller
   * that discards the result has not already changed its own state.
   */
  pseudonyms: Pseudonyms
}

/** A detector is any function that turns text into candidates. Add more freely. */
export interface Detector {
  id: string
  layer: DetectorLayer
  run: (text: string) => Candidate[]
}
