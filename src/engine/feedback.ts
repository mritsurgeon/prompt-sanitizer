import { category } from './categories'
import type { ScanResult } from './detect'
import type { Group, SensitivityState } from './types'

/**
 * Local-only foundation for a future document classifier.
 *
 * The document sensitivity engine is deliberately rule-based because we have
 * no labelled data for this organisation's actual classification policy. This
 * module is how that data could eventually be collected: every assessment is
 * recorded in a shape that a classifier could train on, together with whatever
 * the user decided.
 *
 * Three deliberate constraints:
 *
 *  1. **Nothing leaves the machine.** There is no transport here at all — no
 *     fetch, no beacon, no storage adapter. The records live in memory for the
 *     life of the tab.
 *  2. **No raw content by default.** A record stores the *shape* of an
 *     assessment: counts, signal ids, topics. The text itself is only captured
 *     if a caller explicitly passes `includeSample`, which nothing does today.
 *  3. **Nothing is trained.** This is a dataset foundation, not a model.
 *
 * `exportDataset()` returns JSON the user could choose to save. That is the
 * only way anything gets out.
 */

export type SensitivityLabel =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'unknown'

export interface AssessmentFingerprint {
  chars: number
  findingCounts: Record<Group, number>
  documentState: SensitivityState
  documentConfidence: number
  /** Signal families that fired, e.g. "topic:roadmap", "metadata". */
  topics: string[]
  /** Individual signal ids, for feature extraction later. */
  signalIds: string[]
  ambiguousCount: number
  escalated: boolean
}

export interface AssessmentRecord {
  id: string
  at: string
  /** File name only — never contents. */
  filename?: string
  fingerprint: AssessmentFingerprint
  systemState: SensitivityState
  userDecision: 'unreviewed' | 'accepted' | 'overridden'
  label?: SensitivityLabel
  /** Only present when a caller explicitly opted in. */
  sample?: string
}

/** Keep the footprint bounded; this is a scratchpad, not an archive. */
const MAX_RECORDS = 200

const records: AssessmentRecord[] = []
let counter = 0

export interface RecordOptions {
  filename?: string
  /**
   * Capture the scanned text alongside the fingerprint. Off by default and
   * currently unused by the app — present so a future opt-in "help improve
   * detection locally" flow has somewhere to put the data.
   */
  includeSample?: boolean
}

export function recordAssessment(
  result: ScanResult,
  options: RecordOptions = {},
): AssessmentRecord {
  const findingCounts: Record<Group, number> = {
    personal: 0,
    internal: 0,
    confidential: 0,
    secret: 0,
  }
  for (const finding of result.findings) {
    findingCounts[category(finding.category).group] += 1
  }

  const record: AssessmentRecord = {
    id: `a${++counter}`,
    at: new Date().toISOString(),
    filename: options.filename,
    fingerprint: {
      chars: result.text.length,
      findingCounts,
      documentState: result.document.state,
      documentConfidence: Number(result.document.confidence.toFixed(3)),
      topics: result.document.topics,
      signalIds: result.document.signals.map((s) => s.id),
      ambiguousCount: result.ambiguous.length,
      escalated: result.escalation.modelInvoked,
    },
    systemState: result.document.state,
    userDecision: 'unreviewed',
    sample: options.includeSample ? result.text : undefined,
  }

  records.push(record)
  if (records.length > MAX_RECORDS) records.shift()
  return record
}

/** Called if the user disagrees with, or confirms, the document assessment. */
export function labelAssessment(
  id: string,
  label: SensitivityLabel,
  decision: AssessmentRecord['userDecision'] = 'overridden',
): void {
  const record = records.find((r) => r.id === id)
  if (!record) return
  record.label = label
  record.userDecision = decision
}

export function getDataset(): readonly AssessmentRecord[] {
  return records
}

/** The only way data leaves this module — and only if a human asks for it. */
export function exportDataset(): string {
  return JSON.stringify({ version: 1, records }, null, 2)
}

export function clearDataset(): void {
  records.length = 0
}
