import { MEDIUM_THRESHOLD, tierFor } from '../context'
import type { Finding } from '../types'
import { deepContextConfirmer } from './deepContext'
import type {
  ConfirmationRequest,
  ConfirmationVerdict,
  DiscoveredEntity,
  LocalModelDetector,
} from './types'

export type {
  LocalModelDetector,
  ConfirmationRequest,
  ConfirmationVerdict,
  DiscoveredEntity,
}

/**
 * Registry for the second-stage confirmer.
 *
 * Exactly one is active. The default is the deterministic deep-context pass,
 * which needs no files and cannot fail. A provisioned local model can replace
 * it at startup via `registerLocalModel` without any other file changing.
 */
let active: LocalModelDetector = deepContextConfirmer

export function registerLocalModel(detector: LocalModelDetector): void {
  active = detector
}

export function getLocalModel(): LocalModelDetector {
  return active
}

export function resetLocalModel(): void {
  active = deepContextConfirmer
}

/**
 * Load the confirmer ahead of a scan we know is coming.
 *
 * Attaching a document is a strong signal: reading it already takes a moment,
 * the user has not clicked anything yet, and a document large enough to open is
 * very likely to contain something ambiguous. Starting the load during that
 * dead time hides most of the one-off cost, which is the only part anybody
 * notices.
 *
 * Deliberately not called when text is pasted — that path is instant, and
 * loading a model for it would put weights on the normal path for no gain.
 *
 * Fire and forget: this never throws and never blocks. If it fails, the scan
 * falls back exactly as it would have.
 */
export function warmUp(): void {
  const model = active
  if (model.loaded) return

  void (async () => {
    try {
      if (await model.isAvailable()) await model.load()
    } catch {
      // The scan will report the failure properly if it ever needs the model.
    }
  })()
}

/** How much text the confirmer gets to see around a candidate. */
export const WINDOW_RADIUS = 160

/** Snap a window to word boundaries so the confirmer never sees half a word. */
function windowFor(text: string, start: number, end: number) {
  let from = Math.max(0, start - WINDOW_RADIUS)
  let to = Math.min(text.length, end + WINDOW_RADIUS)
  while (from > 0 && /\w/.test(text[from - 1])) from -= 1
  while (to < text.length && /\w/.test(text[to])) to += 1
  return { window: text.slice(from, to), offset: start - from, windowStart: from }
}

export interface EscalationStats {
  /** How many findings were ambiguous enough to be worth a second look. */
  ambiguous: number
  /** How many low-confidence unknowns were offered for recovery. */
  offered: number
  modelId: string
  modelAvailable: boolean
  /** The single most important number: did the expensive path run at all? */
  modelInvoked: boolean
  modelLoaded: boolean
  confirmed: number
  rejected: number
  unresolved: number
  /** Rules had no opinion, the confirmer said yes — a recovered miss. */
  recovered: number
  /** The confirmer saw it and the rules never proposed it at all. */
  discovered: number
  ms: number
  /** Set when the confirmer failed and the fast-path result was kept. */
  error?: string
}

export const NO_ESCALATION: EscalationStats = {
  ambiguous: 0,
  offered: 0,
  modelId: 'none',
  modelAvailable: false,
  modelInvoked: false,
  modelLoaded: false,
  confirmed: 0,
  rejected: 0,
  unresolved: 0,
  recovered: 0,
  discovered: 0,
  ms: 0,
}

export interface ConfirmationOutcome {
  findings: Finding[]
  stats: EscalationStats
}

/**
 * Runs the confirmer over the ambiguous findings only, and applies the
 * verdicts. A confirmed finding is promoted; a rejected one is dropped.
 *
 * Failure is never fatal: if the confirmer cannot load, times out or throws,
 * the fast-path findings are returned untouched and the reason is recorded.
 */
export async function confirmAmbiguous(
  text: string,
  findings: Finding[],
  recoverable: Finding[] = [],
  declined: Array<{ start: number; end: number }> = [],
  /** Overridden only by the fallback path below. */
  model: LocalModelDetector = active,
): Promise<ConfirmationOutcome> {
  const ambiguous = findings.filter((f) => f.tier === 'medium')

  /**
   * Recovery candidates alone are not a reason to load a model.
   *
   * An ambiguous finding means the rules reached a conclusion they could not
   * stand behind — that earns the cost of loading. A recovery candidate only
   * means "there is a capitalised word here nobody recognises", which is
   * speculative, and paying a cold start for it would put a model on the
   * normal path. So a confirmer with weights must be earned: while it is cold,
   * ambiguity is required; once resident, the marginal cost is milliseconds
   * and speculating is worth it. A confirmer that costs nothing to run (the
   * deterministic pass) is never gated.
   */
  const free = model.cost.bytes === 0
  const candidates =
    ambiguous.length > 0 || free || model.loaded ? recoverable : []

  if (!ambiguous.length && !candidates.length) {
    // The whole point of the architecture: nothing ambiguous, nothing loaded.
    return {
      findings,
      stats: {
        ...NO_ESCALATION,
        modelId: model.id,
        modelAvailable: true,
        modelLoaded: model.loaded,
      },
    }
  }

  const started = performance.now()
  const base: EscalationStats = {
    ...NO_ESCALATION,
    ambiguous: ambiguous.length,
    offered: candidates.length,
    modelId: model.id,
  }

  try {
    // An unprovisioned model must not mean *no* second opinion. Fall back to
    // the deterministic pass, which needs no files and cannot be unavailable.
    if (!(await model.isAvailable())) {
      if (model === deepContextConfirmer) {
        return { findings, stats: { ...base, ms: performance.now() - started } }
      }
      console.warn(
        `[ai-safe] "${model.id}" is not provisioned — falling back to the ` +
          `${deepContextConfirmer.id} confirmer. Run \`npm run provision:model\`.`,
      )
      const fallback = await confirmAmbiguous(
        text,
        findings,
        candidates,
        declined,
        deepContextConfirmer,
      )
      return {
        findings: fallback.findings,
        stats: {
          ...fallback.stats,
          modelId: `${model.id} → ${deepContextConfirmer.id}`,
          error: `${model.id} is not provisioned`,
        },
      }
    }

    await model.load()

    const toRequest = (finding: Finding, unknown: boolean): ConfirmationRequest => {
      const { window, offset, windowStart } = windowFor(
        text,
        finding.start,
        finding.end,
      )
      return {
        id: finding.id,
        value: finding.value,
        category: finding.category,
        window,
        offset,
        windowStart,
        unresolved: unknown,
      }
    }

    const requests: ConfirmationRequest[] = [
      ...ambiguous.map((f) => toRequest(f, false)),
      ...candidates.map((f) => toRequest(f, true)),
    ]

    const verdicts = await model.confirm(requests)
    const byId = new Map(verdicts.map((v) => [v.id, v]))

    let confirmed = 0
    let rejected = 0
    let unresolved = 0
    let recovered = 0
    const resolved: Finding[] = []

    const vouched = (finding: Finding, verdict: ConfirmationVerdict): Finding => {
      const confidence = Math.max(finding.confidence, verdict.confidence)
      // The confirmer may know better what this actually is.
      const relabelled = verdict.category && verdict.category !== finding.category
      return {
        ...finding,
        category: verdict.category ?? finding.category,
        confidence,
        tier: tierFor(Math.max(confidence, MEDIUM_THRESHOLD)),
        rule: relabelled ? `Relabelled by the ${model.label}` : finding.rule,
        confirmedBy: model.id,
        signals: [
          ...finding.signals,
          {
            id: `confirmed:${model.id}`,
            weight: 0,
            note: verdict.note ?? `Checked again by the ${model.label}.`,
          },
        ],
      }
    }

    // --- the precision half: overturn or uphold what the rules called -----
    for (const finding of findings) {
      const verdict = byId.get(finding.id)
      if (!verdict || finding.tier !== 'medium') {
        resolved.push(finding)
        continue
      }

      if (verdict.decision === 'confirm') {
        confirmed += 1
        resolved.push(vouched(finding, verdict))
        continue
      }

      // A rejection removes the finding.
      //
      // The confirmer only answers on the categories it was trained for —
      // people, companies, places — and on those it is a model trained on far
      // more text than any hand-written rule encodes. Where the two disagree
      // about a name, it is usually the rule that is guessing from shape. It
      // is never consulted about emails, keys or identifiers, so it cannot
      // overturn those: `confirm()` returns "unknown" for anything outside its
      // competence, and unknown leaves the finding exactly as it was.
      if (verdict.decision === 'reject') {
        rejected += 1
        continue
      }

      unresolved += 1
      resolved.push({
        ...finding,
        confirmedBy: model.id,
        signals: verdict.note
          ? [...finding.signals, { id: `checked:${model.id}`, weight: 0, note: verdict.note }]
          : finding.signals,
      })
    }

    // --- the recall half: promote what the rules never called -------------
    for (const candidate of candidates) {
      const verdict = byId.get(candidate.id)
      if (verdict?.decision !== 'confirm') continue
      recovered += 1
      resolved.push(vouched(candidate, verdict))
    }

    // --- and anything the confirmer saw that we never proposed ------------
    const taken = new Uint8Array(text.length)
    for (const finding of resolved) {
      for (let i = finding.start; i < finding.end; i++) taken[i] = 1
    }
    // Block the spans the rules examined and turned down. Discovery is for
    // text nobody assessed, not a second vote on a settled one.
    for (const span of declined) {
      for (let i = span.start; i < span.end; i++) taken[i] = 1
    }

    let discovered = 0
    for (const verdict of verdicts) {
      for (const entity of verdict.discovered ?? []) {
        if (entity.start < 0 || entity.end > text.length) continue
        let overlaps = false
        for (let i = entity.start; i < entity.end; i++) {
          if (taken[i]) {
            overlaps = true
            break
          }
        }
        if (overlaps) continue
        for (let i = entity.start; i < entity.end; i++) taken[i] = 1

        discovered += 1
        resolved.push({
          id: `d${discovered}`,
          category: entity.category,
          value: entity.value,
          start: entity.start,
          end: entity.end,
          confidence: entity.confidence,
          tier: tierFor(Math.max(entity.confidence, MEDIUM_THRESHOLD)),
          layer: 'entity',
          rule: `Spotted by the ${model.label}`,
          confirmedBy: model.id,
          enabled: true,
          signals: [
            {
              id: `discovered:${model.id}`,
              weight: 0,
              note: `The word lists did not recognise this, but the ${model.label} identified it.`,
            },
          ],
        })
      }
    }

    // --- one value, one answer --------------------------------------------
    // The confirmer judges each mention on its own window, so the same word can
    // come back as a person in one sentence and a company in the next. That
    // reads as a bug to anyone looking at the output, and it is: whatever
    // "Kena" is, it is the same thing in both places. Settle every mention on
    // the reading of its most confident occurrence.
    const strongest = new Map<string, Finding>()
    for (const finding of resolved) {
      const key = finding.value.toLowerCase()
      const held = strongest.get(key)
      if (!held || finding.confidence > held.confidence) {
        strongest.set(key, finding)
      }
    }

    const consistent = resolved.map((finding) => {
      const best = strongest.get(finding.value.toLowerCase())
      if (!best || best === finding || best.category === finding.category) {
        return finding
      }
      return {
        ...finding,
        category: best.category,
        confidence: Math.max(finding.confidence, best.confidence),
        tier: best.tier,
        signals: [
          ...finding.signals,
          {
            id: 'consistent-category',
            weight: 0,
            note: `Matched to the same value elsewhere in this content.`,
          },
        ],
      }
    })

    return {
      findings: consistent.sort((a, b) => a.start - b.start),
      stats: {
        ...base,
        modelAvailable: true,
        modelInvoked: true,
        modelLoaded: model.loaded,
        confirmed,
        rejected,
        unresolved,
        recovered,
        discovered,
        ms: performance.now() - started,
      },
    }
  } catch (cause) {
    // Degrade safely — the user still gets the fast-path findings. But say so
    // loudly in the console: a confirmer that silently stops running looks
    // exactly like one that is working, and the findings quietly get worse.
    console.warn(
      `[ai-safe] The "${model.id}" confirmer failed, so this scan used the fast path only.`,
      cause,
    )
    return {
      findings,
      stats: {
        ...base,
        modelAvailable: true,
        modelInvoked: true,
        ms: performance.now() - started,
        error: cause instanceof Error ? cause.message : 'confirmation failed',
      },
    }
  }
}
