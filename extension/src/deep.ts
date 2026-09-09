import { category } from '@/engine/categories'
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
