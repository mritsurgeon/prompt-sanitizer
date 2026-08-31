import { category } from './categories'
import type { ScanResult } from './detect'
import type { Finding, Group, Severity, Tier } from './types'

/**
 * The policy layer: findings in, a decision out.
 *
 * Detection answers "what is here". Policy answers "what should happen about
 * it", and those are different questions with different owners — the same
 * finding warrants a block in one organisation and a shrug in another. Keeping
 * them apart means the browser enforcement point contains no judgement of its
 * own; it asks this, and does what it is told.
 *
 * Lives in the engine rather than the extension so the app, the extension and
 * the tests all reach the same verdict from the same rules.
 */

export type Decision = 'allow' | 'warn' | 'block'

/** What each decision means at the enforcement point. */
export const DECISION_ORDER: Decision[] = ['allow', 'warn', 'block']

const rank = (d: Decision) => DECISION_ORDER.indexOf(d)
const strongest = (a: Decision, b: Decision) => (rank(b) > rank(a) ? b : a)

export interface Policy {
  /** What to do about credentials, keys and passwords. */
  secret: Decision
  /** What to do about names, emails, phone numbers, identity numbers. */
  personal: Decision
  /** What to do about roadmaps, pricing and internal plans. */
  confidential: Decision
  /** What to do about hostnames, customer numbers and case references. */
  internal: Decision
  /**
   * Findings the engine is not certain about never escalate beyond this.
   * A "possible" name should not stop somebody working.
   */
  uncertainCeiling: Decision
  /**
   * What to do when the engine itself cannot be consulted. Explicit rather
   * than assumed, because silently treating an unknown as safe is the worst
   * of the available failures.
   */
  onEngineUnavailable: Decision
}

/**
 * Deliberately not maximal. A tool that blocks constantly gets switched off,
 * and then it protects nothing — so only live credentials stop the user
 * outright, and everything else asks.
 */
export const DEFAULT_POLICY: Policy = {
  secret: 'block',
  personal: 'warn',
  confidential: 'warn',
  internal: 'warn',
  uncertainCeiling: 'warn',
  onEngineUnavailable: 'warn',
}

/** Nothing is enforced; useful for observing what a policy *would* do. */
export const OBSERVE_ONLY: Policy = {
  secret: 'warn',
  personal: 'allow',
  confidential: 'allow',
  internal: 'allow',
  uncertainCeiling: 'allow',
  onEngineUnavailable: 'allow',
}

const GROUP_DECISION: Record<Group, keyof Policy> = {
  secret: 'secret',
  personal: 'personal',
  confidential: 'confidential',
  internal: 'internal',
}

export interface PolicyOutcome {
  decision: Decision
  /** One line, written for the person about to hit send. */
  headline: string
  /** The findings that drove the decision, strongest first. */
  drivers: Finding[]
  /** Every finding considered, for the review panel. */
  findings: Finding[]
  /** Plain-English counts, e.g. "1 password, 2 email addresses". */
  summary: string
}

const SEVERITY_ORDER: Severity[] = ['low', 'medium', 'high', 'critical']

function worst(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sa = SEVERITY_ORDER.indexOf(category(a.category).severity)
    const sb = SEVERITY_ORDER.indexOf(category(b.category).severity)
    if (sa !== sb) return sb - sa
    return b.confidence - a.confidence
  })
}

/** "2 email addresses, 1 password" — what, not how many rules fired. */
function describe(findings: Finding[]): string {
  const counts = new Map<string, number>()
  for (const finding of findings) {
    const label = category(finding.category).label.toLowerCase()
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, n]) => `${n} ${label}${n === 1 ? '' : 's'}`)
    .join(', ')
}

/**
 * The decision a single finding argues for, before the ceiling is applied.
 */
export function decisionFor(finding: Finding, policy: Policy): Decision {
  const meta = category(finding.category)
  const wanted = policy[GROUP_DECISION[meta.group]] as Decision

  // Uncertainty caps the response. The engine says "possible" for a reason,
  // and a maybe should never be the thing that blocks somebody's work.
  if (finding.tier !== ('high' satisfies Tier)) {
    return rank(wanted) > rank(policy.uncertainCeiling)
      ? policy.uncertainCeiling
      : wanted
  }

  return wanted
}

/**
 * Evaluate a completed scan.
 *
 * Note what this does *not* do: it never re-detects anything. The findings
 * arrive already scored and already resolved by the engine, and policy only
 * chooses a response to them.
 */
export function evaluate(
  result: Pick<ScanResult, 'findings'>,
  policy: Policy = DEFAULT_POLICY,
): PolicyOutcome {
  const findings = result.findings.filter((f) => f.enabled)

  if (!findings.length) {
    return {
      decision: 'allow',
      headline: 'Nothing sensitive found',
      drivers: [],
      findings: [],
      summary: '',
    }
  }

  let decision: Decision = 'allow'
  const drivers: Finding[] = []

  for (const finding of findings) {
    const wanted = decisionFor(finding, policy)
    if (wanted === 'allow') continue
    decision = strongest(decision, wanted)
    drivers.push(finding)
  }

  const ranked = worst(drivers)
  const summary = describe(ranked)

  const headline =
    decision === 'block'
      ? 'Sensitive information detected'
      : decision === 'warn'
        ? 'Check this before sending'
        : 'Nothing sensitive found'

  return { decision, headline, drivers: ranked, findings, summary }
}

/**
 * The decision when the engine could not be reached at all.
 *
 * Separate from `evaluate` on purpose: "we found nothing" and "we could not
 * look" are different states, and collapsing them into a quiet allow is how a
 * safety tool ends up protecting nothing.
 */
export function unavailableOutcome(
  policy: Policy = DEFAULT_POLICY,
): PolicyOutcome {
  return {
    decision: policy.onEngineUnavailable,
    headline: 'Could not check this content',
    drivers: [],
    findings: [],
    summary: 'the checker did not respond',
  }
}
