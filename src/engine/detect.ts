import { category } from './categories'
import { businessDetector } from './detectors/business'
import { entityDetector } from './detectors/entities'
import { patternDetector } from './detectors/patterns'
import { computeRisk } from './risk'
import type { Detector, Finding, RiskSummary } from './types'

/**
 * The detector registry. Layers run independently and their results are merged,
 * so no single technique is load-bearing — add or swap a layer here.
 */
export const DETECTORS: Detector[] = [
  patternDetector,
  entityDetector,
  businessDetector,
]

export interface ScanResult {
  text: string
  findings: Finding[]
  risk: RiskSummary
  durationMs: number
}

/**
 * Resolve overlapping claims. Higher-priority categories win outright; ties
 * are broken by longer match, then higher confidence. Nothing is dropped
 * silently — a discarded finding was always covered by a stronger one.
 */
function resolveOverlaps(raw: Omit<Finding, 'id' | 'enabled'>[]): Finding[] {
  const sorted = [...raw].sort((a, b) => {
    const pa = category(a.category).priority
    const pb = category(b.category).priority
    if (pa !== pb) return pb - pa
    const la = a.end - a.start
    const lb = b.end - b.start
    if (la !== lb) return lb - la
    return b.confidence - a.confidence
  })

  const kept: Omit<Finding, 'id' | 'enabled'>[] = []
  for (const candidate of sorted) {
    const clashes = kept.some(
      (k) => candidate.start < k.end && k.start < candidate.end,
    )
    if (!clashes) kept.push(candidate)
  }

  return kept
    .sort((a, b) => a.start - b.start)
    .map((f, i) => ({ ...f, id: `f${i}`, enabled: true }))
}

export function scan(text: string): ScanResult {
  const started = performance.now()

  const raw = DETECTORS.flatMap((detector) => {
    try {
      return detector.run(text)
    } catch {
      // A broken rule must never take the whole scan down.
      return []
    }
  })

  const findings = resolveOverlaps(raw)

  return {
    text,
    findings,
    risk: computeRisk(findings),
    durationMs: performance.now() - started,
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
