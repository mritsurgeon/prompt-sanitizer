import type { ExecutionProvider } from '../metrics'
import type { CategoryId } from '../types'

/**
 * The second-stage confirmation seam.
 *
 * Anything that can look at one ambiguous candidate in a small window of text
 * and say "yes that is a person" / "no it isn't" can plug in here — the
 * deterministic deep-context confirmer that ships by default, or a local
 * neural model provisioned alongside the app. Nothing else in the engine knows
 * which one is installed.
 */

export interface ConfirmationRequest {
  /** Matches the finding id, so verdicts can be mapped back. */
  id: string
  value: string
  category: CategoryId
  /**
   * The smallest useful slice of text around the candidate. We never hand a
   * whole document to a confirmer to resolve one word.
   */
  window: string
  /** Offset of `value` within `window`. */
  offset: number
  /** Absolute offset of `window` in the scanned text, so anything the
   *  confirmer notices can be mapped back to the document. */
  windowStart: number
  /**
   * True when the rules had no opinion at all — a capitalised token no
   * gazetteer recognises. These are asked about to recover misses, rather
   * than to overturn a judgement.
   */
  unresolved?: boolean
}

/**
 * Something the confirmer noticed that the rules never proposed. This is the
 * false-negative half of the job: a name no word list contains is invisible to
 * the fast path, and no amount of rule tuning finds it.
 */
export interface DiscoveredEntity {
  value: string
  category: CategoryId
  /** Absolute offsets into the scanned text. */
  start: number
  end: number
  confidence: number
}

export interface ConfirmationVerdict {
  id: string
  decision: 'confirm' | 'reject' | 'unknown'
  /** 0..1 — how strongly the confirmer holds that view. */
  confidence: number
  /** Plain English, surfaced in the finding's explanation. */
  note?: string
  /**
   * Set when the confirmer agrees something sensitive is here but disagrees
   * about *what*. The rules guess a category from shape alone, so "Nokia Bell
   * Labs" arrives as a possible person; a model that recognises it as an
   * organisation should be able to correct the label rather than have its
   * agreement recorded under the wrong one.
   */
  category?: CategoryId
  /** Entities seen in this window that the rules had not proposed. */
  discovered?: DiscoveredEntity[]
}

export interface ModelCost {
  /** Bytes that must be provisioned on disk. 0 for a code-only confirmer. */
  bytes: number
  /** Measured one-off load cost, or null if never measured. */
  startupMs: number | null
  /** Measured per-candidate inference cost, or null. */
  perCandidateMs: number | null
}

/**
 * What the confirmer knows about its own execution that the engine cannot see.
 *
 * Optional, because a deterministic confirmer has no execution provider and
 * no tokenizer — it reports nothing and the envelope records `none`.
 */
export interface ModelRuntime {
  ep: ExecutionProvider
  /** Labels passed to the model. Moves from ~10 to 2 under confusion-set
   *  restriction, so it has to be observable before and after. */
  labelCount?: number
  tokenCountBucket?: 64 | 128 | 256 | 512
}

export interface LocalModelDetector {
  id: string
  label: string
  cost: ModelCost
  /** Populated once loaded, by confirmers that run a tensor runtime. */
  readonly runtime?: ModelRuntime
  /** Cheap check — must not load anything. */
  isAvailable(): Promise<boolean>
  /** Idempotent. Called only when there is at least one ambiguous candidate. */
  load(): Promise<void>
  confirm(requests: ConfirmationRequest[]): Promise<ConfirmationVerdict[]>
  readonly loaded: boolean
}
