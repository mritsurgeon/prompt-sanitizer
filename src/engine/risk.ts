import { category } from './categories'
import type { Finding, RiskCounts, RiskLevel, RiskSummary, Severity } from './types'

/** How much each severity contributes before the curve is applied. */
const WEIGHT: Record<Severity, number> = {
  critical: 45,
  high: 18,
  medium: 8,
  low: 2,
}

/**
 * Turns a set of findings into a 0-100 score.
 *
 * The curve (1 - e^-x) means the first few sensitive items move the number a
 * lot and the twentieth barely moves it — which matches how a human judges
 * risk, and stops a long document pinning at 100 forever.
 */
export function computeRisk(findings: Finding[]): RiskSummary {
  const active = findings.filter((f) => f.enabled)

  const counts: RiskCounts = {
    personal: 0,
    internal: 0,
    secret: 0,
    total: active.length,
  }

  let total = 0
  let hasCritical = false

  for (const finding of active) {
    const meta = category(finding.category)
    counts[meta.group] += 1
    total += WEIGHT[meta.severity] * finding.confidence
    if (meta.severity === 'critical') hasCritical = true
  }

  const score = total === 0 ? 0 : Math.round(100 * (1 - Math.exp(-total / 60)))

  let level: RiskLevel = 'safe'
  if (score >= 60 || hasCritical) level = 'high'
  else if (score >= 25) level = 'moderate'
  else if (score > 0) level = 'low'

  return { score, level, counts }
}

export const LEVEL_COPY: Record<
  RiskLevel,
  { headline: string; sub: string; tone: string }
> = {
  safe: {
    headline: 'Looks safe to share',
    sub: 'We did not find anything sensitive in this content.',
    tone: 'var(--risk-safe)',
  },
  low: {
    headline: 'Almost ready',
    sub: 'We found a couple of things worth removing first.',
    tone: 'var(--risk-medium)',
  },
  moderate: {
    headline: 'Needs cleaning',
    sub: 'There are details here you probably should not share with an AI tool.',
    tone: 'var(--risk-high)',
  },
  high: {
    headline: 'Needs cleaning',
    sub: 'This contains information that should not leave the company.',
    tone: 'var(--risk-critical)',
  },
}
