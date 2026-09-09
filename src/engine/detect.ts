import { suppressAllowed } from './allowlist'
import { category } from './categories'
import { classifyDocument, type DocumentClassification } from './classify'
import {
  assessCandidates,
  buildIndex,
  toFinding,
  type AssessedCandidate,
} from './context'
import { confirmAmbiguous, NO_ESCALATION, type EscalationStats } from './confirm'
import type { MetricsPhase } from './metrics'
import { businessDetector } from './detectors/business'
import { confidentialDetector } from './detectors/confidential'
import { entityDetector } from './detectors/entities'
import { patternDetector } from './detectors/patterns'
import { assessDocument } from './documentSensitivity'
import { normalise, type Normalised } from './normalise'
import { computeRisk } from './risk'
import type {
  Detector,
  DocumentMeta,
  DocumentSensitivity,
  Finding,
  RiskSummary,
} from './types'

/**
 * The detector registry. Layers run independently and their results are merged,
 * so no single technique is load-bearing — add or swap a layer here.
 */
export const DETECTORS: Detector[] = [
  patternDetector, // layer 1 — deterministic patterns
  entityDetector, // layer 2a — people, companies, places
  businessDetector, // layer 3 — internal identifiers and infrastructure
  confidentialDetector, // layer 3b — company-confidential spans
]

export interface ScanOptions {
  /** Filename, sheet names and headings feed the document assessment. */
  meta?: DocumentMeta
  /**
   * The string used to join structurally separate values, such as the cells of
   * a spreadsheet row.
   *
   * A finding is only useful if the sanitizer can actually replace it. A match
   * spanning two spreadsheet cells exists in the flattened text but in no
   * single cell, so the file writer could never remove it — the UI would
   * promise a cleanup that never happens. Findings that cross this boundary
   * are therefore discarded.
   */
  structuralDelimiter?: string
  /**
   * Which surface is asking, recorded on the metrics envelope.
   *
   * The engine has no way to know whether anybody is waiting on it, and the
   * acceptable latency differs by an order of magnitude between a held send
   * and a background pass behind a banner — so a p95 that mixes them says
   * nothing. Callers name their surface; the default is `unknown`.
   */
  phase?: MetricsPhase
}

export interface ScanResult {
  text: string
  findings: Finding[]
  risk: RiskSummary
  /** Document-level judgement, separate from the PII findings. */
  document: DocumentSensitivity
  /** What this document is about, what it is, and whose it is. */
  classification: DocumentClassification
  /** Findings that are worth a second opinion — the precision half. */
  ambiguous: Finding[]
  /**
   * Candidates the rules had no opinion about: capitalised words no gazetteer
   * recognises, which scored too low to show. They are not findings and are
   * never displayed — but they are the only way a confirmer can recover a name
   * no word list contains, so they are offered to it. The recall half.
   */
  recoverable: Finding[]
  /**
   * Spans the rules looked at and actively decided against. Not shown, and not
   * offered for recovery — they exist so a confirmer cannot reintroduce
   * something the fast path rejected on evidence it could see and the
   * confirmer's small window cannot.
   */
  declined: Array<{ start: number; end: number }>
  durationMs: number
  /** Candidates dropped because the user allowlisted them. */
  suppressed: number
  escalation: EscalationStats
  /**
   * True when the input contained characters that had to be normalised before
   * the rules could see it — a zero-width space inside a token, a Cyrillic
   * lookalike in a domain, a soft hyphen left by PDF extraction.
   *
   * Reported because it is worth knowing on its own: text is not usually
   * obfuscated by accident, and a caller may want to say so.
   */
  normalised: boolean
}

/**
 * Categories whose value may legitimately contain a line break. Everything
 * else that spans one is a greedy match that has run off the end of a line and
 * swallowed the start of the next — a row number in a table becoming the last
 * digit of a "phone number", for instance.
 */
const MULTILINE_OK: Set<string> = new Set(['PRIVATE_KEY'])

/**
 * Bounds on the recall path. A confirmer costs real time per candidate, and a
 * long document contains hundreds of unrecognised capitalised words, so only
 * the most promising ones are offered and the rest are left alone.
 *
 * These are speculative — the rules had no opinion, we are simply asking. So
 * the budget is small: the ambiguous findings are the ones that earned a
 * second look, and they are never capped.
 */
export const MAX_RECOVERABLE = 12
/**
 * Below this the rules had real evidence against it; leave it dropped. Set
 * clear of the arithmetic — a candidate scoring exactly at the boundary lands
 * on 0.19999… in floating point and would fall through.
 */
export const RECOVERABLE_FLOOR = 0.15
/** Bound on how many rejections we remember, for the same reason. */
export const MAX_DECLINED = 500

function spansLine(item: AssessedCandidate): boolean {
  return !MULTILINE_OK.has(item.category) && /[\r\n]/.test(item.value)
}

/**
 * Resolve overlapping claims. Higher-priority categories win outright; ties
 * are broken by longer match, then higher confidence.
 *
 * Uses a claimed-character bitmap rather than comparing each candidate against
 * every accepted one, which keeps this linear in total match length — it used
 * to be the dominant cost on large documents.
 */
function resolveOverlaps(
  items: AssessedCandidate[],
  length: number,
): AssessedCandidate[] {
  const sorted = [...items].sort((a, b) => {
    const pa = category(a.category).priority
    const pb = category(b.category).priority
    if (pa !== pb) return pb - pa
    const la = a.end - a.start
    const lb = b.end - b.start
    if (la !== lb) return lb - la
    return b.confidence - a.confidence
  })

  const claimed = new Uint8Array(length)
  const kept: AssessedCandidate[] = []

  candidates: for (const item of sorted) {
    for (let i = item.start; i < item.end; i++) {
      if (claimed[i]) continue candidates
    }
    for (let i = item.start; i < item.end; i++) claimed[i] = 1
    kept.push(item)
  }

  return kept.sort((a, b) => a.start - b.start)
}

/**
 * The fast path. Fully synchronous, no model, no I/O.
 *
 * Layer 1 and 3 find things with a known shape. Layer 2a proposes people and
 * companies. The context engine then scores every candidate using positive and
 * negative evidence, and anything that lands in the low tier is discarded
 * rather than shown — that is where the false-positive reduction comes from.
 */
export function scan(raw: string, options: ScanOptions = {}): ScanResult {
  const started = performance.now()

  /**
   * Everything below runs on the normalised text, and only the findings are
   * projected back at the end.
   *
   * That split is deliberate. The detectors, the context engine, the
   * classifier and the sensitivity assessment all read better signal from
   * normalised text — a rule cannot match a phone number with a non-breaking
   * space in it. But a finding has to point into the document the user
   * actually has, because the sanitizer rewrites that document and the Word
   * writer maps offsets into its runs. So the seam is here, at the boundary,
   * rather than threaded through five files.
   */
  const source: Normalised = normalise(raw)
  const text = source.text

  const proposed = DETECTORS.flatMap((detector) => {
    try {
      return detector.run(text)
    } catch {
      // A broken rule must never take the whole scan down.
      return []
    }
  })

  /**
   * The allowlist, applied here and not later.
   *
   * Everything below reads the candidate list: the classifier, the
   * document-sensitivity assessment (which counts how many distinct companies
   * are named), the context engine's entity-consistency pass, the recoverable
   * budget and the declined list. A value the user has said they do not need
   * warning about should be absent from all of it rather than filtered out at
   * the end having influenced each one.
   */
  const { kept: candidates, suppressed } = suppressAllowed(proposed)

  const classification = classifyDocument(text, options.meta)
  const document = assessDocument(
    text,
    options.meta,
    candidates,
    classification,
  )
  const index = buildIndex(text, candidates, document)
  const assessed = assessCandidates(text, candidates, index)

  const delimiter = options.structuralDelimiter
  const usable = (item: AssessedCandidate) =>
    !(delimiter && item.value.includes(delimiter)) && !spansLine(item)

  const believable = assessed.filter((item) => item.tier !== 'low' && usable(item))
  const resolved = resolveOverlaps(believable, text.length)

  /**
   * Back to the user's coordinates.
   *
   * The value is re-sliced rather than kept, because the sanitizer has to
   * replace what is actually in the document. Reporting the normalised
   * spelling would hand it a string that does not occur there — the finding
   * would be shown and then silently fail to be removed, which is the one
   * outcome worse than not finding it.
   */
  const project = (finding: Finding): Finding => {
    if (!source.changed) return finding
    const [start, end] = source.project(finding.start, finding.end)
    return { ...finding, start, end, value: raw.slice(start, end) }
  }

  const findings = resolved.map((item, i) => project(toFinding(item, `f${i}`)))

  // The rules declined to call these, but they declined out of ignorance
  // rather than out of evidence — nothing argued against them, no gazetteer
  // simply knew the word. Bounded, because a large document is full of them.
  // In normalised coordinates, like `assessed` — the projection above has
  // already happened, so this uses the resolved items rather than the
  // findings.
  const claimed = new Uint8Array(text.length)
  for (const item of resolved) {
    for (let i = item.start; i < item.end; i++) claimed[i] = 1
  }

  const recoverable = assessed
    .filter(
      (item) =>
        item.tier === 'low' &&
        item.unresolved &&
        item.confidence >= RECOVERABLE_FLOOR &&
        usable(item) &&
        !claimed[item.start],
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_RECOVERABLE)
    .map((item, i) => project(toFinding(item, `r${i}`)))

  // Keyed in normalised space, which is what `assessed` carries; `recoverable`
  // has already been projected, so the offered set is rebuilt from the
  // pre-projection items.
  const offeredItems = assessed
    .filter(
      (item) =>
        item.tier === 'low' &&
        item.unresolved &&
        item.confidence >= RECOVERABLE_FLOOR &&
        usable(item) &&
        !claimed[item.start],
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_RECOVERABLE)
  const offered = new Set(offeredItems.map((r) => `${r.start}:${r.end}`))

  const declined = assessed
    .filter(
      (item) =>
        item.tier === 'low' &&
        usable(item) &&
        !offered.has(`${item.start}:${item.end}`),
    )
    .slice(0, MAX_DECLINED)
    .map((item) => {
      const [start, end] = source.changed
        ? source.project(item.start, item.end)
        : [item.start, item.end]
      return { start, end }
    })

  return {
    text: raw,
    findings,
    risk: computeRisk(findings),
    document,
    classification,
    ambiguous: findings.filter((f) => f.tier === 'medium'),
    recoverable,
    declined,
    durationMs: performance.now() - started,
    suppressed,
    escalation: NO_ESCALATION,
    normalised: source.changed,
  }
}

/**
 * The full path: fast scan, then a second opinion on the ambiguous findings
 * only.
 *
 * When nothing is ambiguous this resolves immediately and the confirmer is
 * never loaded or called — which is the whole point of the design. When
 * something is ambiguous, only that handful of candidates is examined, each
 * with a small window of surrounding text rather than the whole document.
 */
export async function scanWithConfirmation(
  text: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const result = scan(text, options)
  if (!result.ambiguous.length && !result.recoverable.length) return result

  const { findings, stats } = await confirmAmbiguous(
    text,
    result.findings,
    result.recoverable,
    result.declined,
    undefined,
    options.phase,
  )

  return {
    ...result,
    findings,
    risk: computeRisk(findings),
    ambiguous: findings.filter((f) => f.tier === 'medium'),
    escalation: stats,
  }
}

/** Groups identical values so the details list reads "3 × john@acme.com". */
export function groupByValue(findings: Finding[]) {
  const map = new Map<string, Finding[]>()
  for (const f of findings) {
    const key = `${f.category}::${f.value.toLowerCase()}`
    const bucket = map.get(key)
    if (bucket) bucket.push(f)
    else map.set(key, [f])
  }
  return [...map.values()]
}
