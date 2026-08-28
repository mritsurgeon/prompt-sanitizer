/**
 * Shared types for the local detection / sanitization engine.
 *
 * Everything in `src/engine` is pure, synchronous and dependency-free so it can
 * run in the browser (or a worker, or Node) without any network access.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low'

/** Plain-English buckets we show to the user. No jargon leaks into the UI. */
export type Group = 'personal' | 'internal' | 'secret'

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
  | 'PROJECT_CODE'
  | 'LICENSE_KEY'
  | 'REFERENCE_ID'
  | 'UUID'
  // --- secrets ------------------------------------------------------------
  | 'API_KEY'
  | 'PASSWORD'
  | 'ACCESS_TOKEN'
  | 'PRIVATE_KEY'
  | 'CONNECTION_STRING'

export type DetectorLayer = 'pattern' | 'entity' | 'business'

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

export interface Finding {
  id: string
  category: CategoryId
  /** The exact text that was matched. */
  value: string
  /** Character offsets into the scanned text. */
  start: number
  end: number
  /** 0..1 — how sure the engine is. Shown as High/Likely/Possible. */
  confidence: number
  layer: DetectorLayer
  /** Human-readable rule name, for explainability. */
  rule: string
  /** Users can switch an individual finding off before cleaning. */
  enabled: boolean
}

export interface RiskCounts {
  personal: number
  internal: number
  secret: number
  total: number
}

export type RiskLevel = 'safe' | 'low' | 'moderate' | 'high'

export interface RiskSummary {
  score: number
  level: RiskLevel
  counts: RiskCounts
}

export type SanitizeMode = 'redact' | 'pseudonymize' | 'synthetic'

export interface Replacement {
  finding: Finding
  replacement: string
  /** Offsets of the replacement inside the sanitized text. */
  start: number
  end: number
}

export interface SanitizeResult {
  text: string
  replacements: Replacement[]
  /** original value -> replacement. Used to rewrite files cell-by-cell. */
  valueMap: Map<string, string>
}

/** A detector is any function that turns text into findings. Add more freely. */
export interface Detector {
  id: string
  layer: DetectorLayer
  run: (text: string) => Omit<Finding, 'id' | 'enabled'>[]
}
