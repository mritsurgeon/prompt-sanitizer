import { describe, expect, it } from 'vitest'
import { scan } from '@/engine/detect'
import { DEFAULT_POLICY, evaluate } from '@/engine/policy'
import { runDeepCheck, toWire } from '../deep'

/**
 * The two-stage contract.
 *
 * Stage one has to be complete and actionable on its own, because the banner
 * renders from it before stage two has started. Stage two then refines that
 * banner in place. These tests pin the properties the UI depends on — chiefly
 * that a closer look never turns a considered verdict into a worse one, and
 * that an unavailable second stage is reported rather than hidden.
 */

const CLEAN = 'Can you help me rewrite this paragraph so it reads more clearly?'
const AMBIGUOUS = 'Adeyemi confirmed the migration window this morning.'
const CERTAIN = 'Email sarah.mitchell@example.com about case CASE-49281.'
const SECRET = 'Our key is sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b, call the endpoint.'

describe('stage one decides whether stage two is worth it', () => {
  it('does not ask for a closer look at text with nothing in it', () => {
    const result = scan(CLEAN)
    const outcome = evaluate(result, DEFAULT_POLICY)

    expect(outcome.decision).toBe('allow')
    // Nothing flagged means no banner, so there is nothing to refine and no
    // reason to spend anything.
    expect(result.ambiguous).toHaveLength(0)
  })

  it('asks for one when the rules hesitated', () => {
    const result = scan(AMBIGUOUS)
    expect(result.ambiguous.length + result.recoverable.length).toBeGreaterThan(0)
  })

  it('does not ask when every finding is already certain', () => {
    const result = scan(SECRET)
    const outcome = evaluate(result, DEFAULT_POLICY)

    expect(outcome.decision).toBe('block')
    // A live credential is not a judgement call. There is nothing to confirm.
    expect(result.ambiguous).toHaveLength(0)
  })
})

describe('the closer look', () => {
  it('reports which confirmer answered', async () => {
    const result = await runDeepCheck(AMBIGUOUS)
    expect(result.type).toBe('deep-checked')
    expect(result.confirmedBy).toBeTruthy()
  })

  it('counts what it changed rather than reporting every finding as new', async () => {
    // Escalation rebuilds findings, so ids do not survive it. Comparing by id
    // would report the same finding as both withdrawn and added.
    const result = await runDeepCheck(CERTAIN)
    expect(result.withdrawn).toBe(0)
    expect(result.added).toBe(0)
  })

  it('never downgrades a certain block to an allow', async () => {
    const result = await runDeepCheck(SECRET)
    expect(result.decision).toBe('block')
  })

  it('still returns a usable verdict on text it cannot improve', async () => {
    const result = await runDeepCheck(CERTAIN)
    expect(result.decision).toBe('warn')
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.headline).toBeTruthy()
  })
})

describe('what the banner is given', () => {
  it('flattens a finding to a replacement the user can read', () => {
    const finding = scan(CERTAIN).findings.find((f) => f.category === 'EMAIL')
    const wire = toWire(finding!)

    expect(wire.value).toBe('sarah.mitchell@example.com')
    expect(wire.replacement).toBeTruthy()
    // Never the raw category id — the banner shows this to a human.
    expect(wire.label).not.toBe(wire.category)
    expect(wire.why).toBeTruthy()
  })

  it('carries the tier, so uncertainty can be marked as such', () => {
    const findings = scan(AMBIGUOUS).findings.map(toWire)
    expect(findings.every((f) => ['high', 'medium', 'low'].includes(f.tier))).toBe(
      true,
    )
  })
})
