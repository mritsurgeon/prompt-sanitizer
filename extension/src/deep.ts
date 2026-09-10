import { category } from '@/engine/categories'
import { getLocalModel, warmUp } from '@/engine/confirm'
import { scan, scanWithConfirmation } from '@/engine/detect'
import { evaluate, getPolicy } from '@/engine/policy'
import { previewReplacement } from '@/engine/sanitize'
import type { Finding } from '@/engine/types'
import type { DeepCheckResponse, WireFinding } from './protocol'

/**
 * Stage two, and the flattening every stage shares.
 *
 * Lives on its own because it runs in two different places. In Chrome it runs
 * inside the offscreen document, where a model can stay resident; everywhere
 * else — Firefox, or Chrome before the offscreen document is ready — it runs
 * in the worker with the deterministic confirmer. Identical code, so the two
 * paths cannot drift, and `confirmedBy` tells the user which one answered.
 */

export function toWire(finding: Finding): WireFinding {
  const meta = category(finding.category)
  return {
    category: finding.category,
    label: meta.label,
    value: finding.value,
    replacement: previewReplacement(finding, 'redact'),
    tier: finding.tier,
    group: meta.group,
    // Prefer the engine's own reasoning when it has one; it is already
    // written for a non-technical reader.
    why:
      finding.signals.filter((s) => s.weight > 0 && s.note)[0]?.note ?? meta.why,
  }
}

/**
 * The findings the closer look settled on, in full.
 *
 * `runDeepCheck` flattens to `WireFinding`, which is a display shape: it
 * carries a label and a reason but no offsets, so nothing can be rewritten
 * from it. Cleaning needs the findings themselves.
 *
 * Split out because the worker cannot produce these. `registerLocalModel` is
 * called in the offscreen document and nowhere else, so an escalation run in
 * the worker resolves to the deterministic confirmer — correct, but blind to
 * exactly the names the model exists to recover. The banner was relayed to
 * the offscreen document and the cleaning was not, so the two disagreed:
 * "Closer look caught 2 more" above a rewrite that masked none of them.
 *
 * Whatever context calls this uses the confirmer registered in it, so the
 * caller decides by *where* it runs rather than by passing a flag.
 */
export async function confirmedFindings(text: string): Promise<Finding[]> {
  // `banner` rather than a phase of its own: cleaning follows a banner the
  // user has already read, so the model is warm and the budget that applied
  // to the check should apply to the rewrite of the same text.
  const result = await scanWithConfirmation(text, { phase: 'banner' })
  return result.findings
}

/**
 * Run the closer look and report what it changed.
 *
 * Only the findings the rules could not settle are examined, and only the
 * window around each one — never the whole prompt. Whatever confirmer is
 * registered in this context answers.
 */
export async function runDeepCheck(text: string): Promise<DeepCheckResponse> {
  const started = performance.now()
  const shallow = scan(text)
  const before = evaluate(shallow, getPolicy())

  /**
   * Earn the load, then keep it.
   *
   * The gate refuses to pay a cold start for recovery candidates alone: a
   * capitalised word nobody recognises is speculative, and loading weights for
   * one would put a model on the normal path. That is right, and on its own it
   * has a hole — the model's whole reason for being here is recall on names no
   * gazetteer contains, which *is* the recovery path. A cold model is refused
   * exactly the work it is best at, and only an *ambiguous* finding ever warms
   * it. A user whose prompts contain unusual names and nothing else never gets
   * the model at all.
   *
   * Observed: a prompt naming Malik Vance and Tariq Al-Mansoor produced zero
   * ambiguous findings and three recovery candidates, so the model stayed cold
   * and both names went unmasked.
   *
   * So this warms it in the background, and only once something has already
   * been flagged. Nothing waits on it — the answer below is returned from
   * whatever confirmer is resident now — but the next prompt has the model,
   * which is the "speculation must be earned" rule the rest of this codebase
   * follows: a banner is already on screen, so the cost is spent against time
   * that was going to pass anyway.
   */
  if (!getLocalModel().loaded && shallow.recoverable.length > 0) warmUp()

  try {
    // Stage two by definition: the banner is already on screen and nobody is
    // waiting on this, which is why its latency budget is generous.
    const deep = await scanWithConfirmation(text, { phase: 'banner' })
    const after = evaluate(deep, getPolicy())

    // Compared by position and value rather than by id: escalation rebuilds
    // findings, so ids do not survive it and comparing them would report every
    // finding as both withdrawn and added.
    const was = new Set(shallow.findings.map((f) => `${f.start}:${f.value}`))
    const now = new Set(deep.findings.map((f) => `${f.start}:${f.value}`))

    return {
      type: 'deep-checked',
      decision: after.decision,
      headline: after.headline,
      summary: after.summary,
      findings: after.drivers.map(toWire),
      confirmedBy: deep.escalation.modelId,
      withdrawn: [...was].filter((key) => !now.has(key)).length,
      added: [...now].filter((key) => !was.has(key)).length,
      ms: performance.now() - started,
      unavailable: deep.escalation.error,
    }
  } catch (cause) {
    // Stage one still stands. Say the closer look did not happen rather than
    // presenting its absence as a clean result.
    return {
      type: 'deep-checked',
      decision: before.decision,
      headline: before.headline,
      summary: before.summary,
      findings: before.drivers.map(toWire),
      withdrawn: 0,
      added: 0,
      ms: performance.now() - started,
      unavailable:
        cause instanceof Error ? cause.message : 'the closer look failed',
    }
  }
}
