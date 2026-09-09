import type { Decision } from '@/engine/policy'

/**
 * The one contract between the page and the engine.
 *
 * Content scripts run inside a hostile document — the AI site's own scripts
 * share that window. So the content script never holds findings, never holds
 * the original text longer than the call, and never makes a decision: it asks
 * the background worker and renders the answer. Everything here is structured
 * data with no behaviour attached.
 */

export type CheckReason = 'paste' | 'submit' | 'file' | 'manual'

export interface CheckRequest {
  type: 'check'
  reason: CheckReason
  text: string
  /** The site, for metrics only. Never the URL or the page title. */
  host: string
}

/**
 * Stage two.
 *
 * Only ever sent after a stage-one check has already flagged something. The
 * model is not a scanner — it is a second opinion on a conclusion the rules
 * could not stand behind, and asking for one on clean text would put weights
 * on the path that has to stay instant.
 */
export interface DeepCheckRequest {
  type: 'deep-check'
  text: string
  host: string
}

/** A finding, flattened to what the in-page banner actually renders. */
export interface WireFinding {
  category: string
  label: string
  value: string
  replacement: string
  tier: string
  group: string
  /** Plain-English reason, already written for a non-technical reader. */
  why: string
}

export interface CheckResponse {
  type: 'checked'
  decision: Decision
  headline: string
  summary: string
  findings: WireFinding[]
  /** Present when the engine could not be consulted. */
  degraded?: string
  /** Milliseconds the engine took, for the latency budget. */
  ms: number
  /**
   * Stage one flagged something the rules could not settle, so a closer look
   * is worth asking for. Purely advisory — the response already stands on its
   * own, and the caller may ignore this entirely.
   */
  deeperAvailable?: boolean
  /** Which confirmer answered, when this response is a stage-two result. */
  confirmedBy?: string
}

/** What the closer look changed, so the banner can say so honestly. */
export interface DeepCheckResponse extends Omit<CheckResponse, 'type'> {
  type: 'deep-checked'
  /** Findings the second opinion withdrew — the false positives it caught. */
  withdrawn: number
  /** Findings only the second opinion saw — the misses it caught. */
  added: number
  /** Set when the closer look could not run; stage one still stands. */
  unavailable?: string
}

export interface SanitizeRequest {
  type: 'sanitize'
  text: string
  host: string
  /**
   * `redact` blanks the value, `pseudonymize` swaps in a consistent stand-in.
   * Both keep the prompt answerable; the second keeps it readable too.
   */
  mode: 'redact' | 'pseudonymize'
  /** Reuse the closer look's findings rather than re-running stage one. */
  deep?: boolean
}

export interface SanitizeResponse {
  type: 'sanitized'
  text: string
  replaced: WireFinding[]
  ms: number
}

export interface StatusRequest {
  type: 'status'
}

export interface StatusResponse {
  type: 'status'
  ready: boolean
  version: string
  /** Counts only. No content, ever. */
  metrics: Metrics
}

export interface Metrics {
  checked: number
  allowed: number
  warned: number
  blocked: number
  sanitized: number
  escalations: number
  /** Rolling latency samples in ms, capped. Used for P50/P95/P99. */
  latencies: number[]
}

/** Opens the web app with this text handed over for manual work. */
export interface HandoffRequest {
  type: 'handoff'
  text: string
}

export interface HandoffResponse {
  type: 'handed-off'
  ok: boolean
  reason?: string
}

/** Sent by the app's own tab once it loads, to collect what was handed over. */
export interface TakeHandoffRequest {
  type: 'take-handoff'
}

export interface TakeHandoffResponse {
  type: 'handoff-text'
  text: string | null
}

/**
 * An attachment, on its way to be read somewhere that can read it.
 *
 * The bytes travel as base64 because MV3 messages are JSON. That is not free —
 * a 5 MB spreadsheet crosses as a 6.7 MB string — so `MAX_ATTACHMENT_BYTES`
 * caps it, and anything larger is announced as unchecked rather than allowed
 * to exhaust the tab.
 */
export interface AttachmentRequest {
  type: 'attachment'
  /** Used for the extension check and as document metadata for the scan. */
  name: string
  bytes: string
  host: string
  /**
   * Set to rewrite the file rather than only judge it. Sent as a second
   * request after the user asks for it, so the common case — look, decide,
   * deliver — moves the bytes once.
   */
  mode?: 'redact' | 'pseudonymize'
}

export interface AttachmentResponse {
  type: 'attachment-checked'
  decision: Decision
  headline: string
  summary: string
  findings: WireFinding[]
  ms: number
  /** Present when `mode` was set and the rewrite succeeded. */
  cleaned?: { bytes: string; name: string }
  /**
   * Present when the file could not be read at all — an unsupported format,
   * a corrupt document, or a browser with no offscreen document. Distinct from
   * a clean result on purpose.
   */
  unreadable?: string
}

/**
 * What the page and the popup need to know about how this browser is
 * configured. Carries no policy detail — only what changes behaviour on the
 * page — because the content script contains no judgement and should not be
 * handed the means to acquire any.
 */
export interface ConfigRequest {
  type: 'config'
}

export interface ConfigResponse {
  type: 'config'
  /** Nothing this policy decides would interrupt anybody. */
  observeOnly: boolean
  /** An organisation is pushing the configuration. */
  managed: boolean
  allowUserOverrides: boolean
}

export type Request =
  | AttachmentRequest
  | ConfigRequest
  | CheckRequest
  | DeepCheckRequest
  | SanitizeRequest
  | StatusRequest
  | HandoffRequest
  | TakeHandoffRequest

export type Response =
  | AttachmentResponse
  | ConfigResponse
  | CheckResponse
  | DeepCheckResponse
  | SanitizeResponse
  | StatusResponse
  | HandoffResponse
  | TakeHandoffResponse

/** Anything larger is not a prompt; refuse rather than freeze the tab. */
export const MAX_TEXT_BYTES = 1_000_000

export const EMPTY_METRICS: Metrics = {
  checked: 0,
  allowed: 0,
  warned: 0,
  blocked: 0,
  sanitized: 0,
  escalations: 0,
  latencies: [],
}
