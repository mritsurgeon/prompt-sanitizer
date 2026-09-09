import { describe, expect, it } from 'vitest'
import { scan } from '../detect'
import {
  DEFAULT_POLICY,
  OBSERVE_ONLY,
  evaluate,
  unavailableOutcome,
  type Policy,
} from '../policy'

/**
 * The policy layer turns findings into an action. These tests pin the
 * behaviour the browser enforcement point depends on — especially that a
 * "possible" finding can never be the thing that stops somebody working.
 */

const decide = (text: string, policy: Policy = DEFAULT_POLICY) =>
  evaluate(scan(text), policy)

describe('what stops a send', () => {
  it('blocks a live credential', () => {
    const outcome = decide(
      'Use the key sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b to authenticate.',
    )
    expect(outcome.decision).toBe('block')
    expect(outcome.headline).toBe('Sensitive information detected')
  })

  it('blocks a password in plain text', () => {
    expect(decide('login admin, password = Summer2024!').decision).toBe('block')
  })

  it('warns rather than blocks on ordinary personal data', () => {
    const outcome = decide(
      'Please contact Sarah Mitchell on sarah.mitchell@example.com.',
    )
    expect(outcome.decision).toBe('warn')
    expect(outcome.summary).toContain('email address')
  })

  it('allows content with nothing in it', () => {
    const outcome = decide('Can you help me rewrite this paragraph more clearly?')
    expect(outcome.decision).toBe('allow')
    expect(outcome.drivers).toHaveLength(0)
  })
})

describe('uncertainty never blocks', () => {
  it('caps an uncertain finding at the ceiling, whatever the category says', () => {
    // A policy that blocks all personal data still may not block on a maybe.
    const strict: Policy = { ...DEFAULT_POLICY, personal: 'block' }
    const outcome = decide('Adeyemi confirmed the migration window.', strict)

    const person = outcome.findings.find((f) => f.category === 'PERSON')
    expect(person?.tier).toBe('medium')
    expect(outcome.decision).not.toBe('block')
  })

  it('a certain finding under the same policy does block', () => {
    const strict: Policy = { ...DEFAULT_POLICY, personal: 'block' }
    expect(decide('Email sarah.mitchell@example.com', strict).decision).toBe(
      'block',
    )
  })
})

describe('policy is configuration, not code', () => {
  it('observe-only really never interrupts, credentials included', () => {
    const outcome = decide(
      'key sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b for Sarah Mitchell',
      OBSERVE_ONLY,
    )
    // A mode called "observe only" that still shows a banner for a credential
    // is misnamed, and the surprise costs more than the warning gains.
    expect(outcome.decision).toBe('allow')
    // Still reports what it saw, which is the entire point of the mode.
    expect(outcome.findings.length).toBeGreaterThan(0)
  })

  it('composes an audit rollout that still speaks up about credentials', () => {
    // The reasonable middle, and it needs no third mode: a base plus one
    // override says exactly what it does.
    const auditButWarn = { ...OBSERVE_ONLY, secret: 'warn' as const }
    expect(decide('key sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b', auditButWarn).decision).toBe(
      'warn',
    )
    expect(decide('Email sarah.mitchell@example.com', auditButWarn).decision).toBe('allow')
  })

  it('takes the strongest decision across all findings', () => {
    // Personal data warns, the key blocks; the result is a block.
    const outcome = decide(
      'Sarah Mitchell, sarah@example.com, key sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b',
    )
    expect(outcome.decision).toBe('block')
  })

  it('ranks the most severe driver first', () => {
    const outcome = decide(
      'Contact sarah@example.com. Key: sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b',
    )
    expect(outcome.drivers[0].category).toBe('API_KEY')
  })
})

describe('respecting the user', () => {
  it('ignores findings the user switched off', () => {
    const result = scan('Contact sarah.mitchell@example.com about this.')
    const disabled = {
      findings: result.findings.map((f) => ({ ...f, enabled: false })),
    }
    expect(evaluate(disabled).decision).toBe('allow')
  })
})

describe('when the engine cannot be reached', () => {
  it('does not quietly report safe', () => {
    const outcome = unavailableOutcome(DEFAULT_POLICY)
    expect(outcome.decision).not.toBe('allow')
    expect(outcome.headline).toBe('Could not check this content')
  })

  it('honours a fail-open configuration when that is the deliberate choice', () => {
    const failOpen: Policy = { ...DEFAULT_POLICY, onEngineUnavailable: 'allow' }
    expect(unavailableOutcome(failOpen).decision).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// The realistic-prompt matrix.
// ---------------------------------------------------------------------------

describe('realistic AI prompts', () => {
  it.each([
    [
      'a customer email rewrite',
      'Help me rewrite this customer email: John Smith from Northwind contacted us at john.smith@example.com regarding his account.',
      'warn',
    ],
    [
      'a pasted credential',
      'Here is our API key: sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b — can you show me how to call the endpoint?',
      'block',
    ],
    [
      'an ordinary question',
      'Can you explain Christian values in modern society?',
      'allow',
    ],
    [
      'a general coding question',
      'Why does my Python script raise a KeyError when the dictionary clearly has that key?',
      'allow',
    ],
    [
      'harmless product talk',
      'We run Kubernetes and Docker in production. What is the best way to handle rolling restarts?',
      'allow',
    ],
  ])('%s', (_name, text, expected) => {
    expect(decide(text).decision).toBe(expected)
  })

  it('flags an internal roadmap without any personal data in it', () => {
    const outcome = decide(
      'Help me summarise our Q4 roadmap — internal use only. Project Phoenix launches in October 2027 and pricing remains under review with the list price and gross margin still being modelled.',
    )
    expect(outcome.decision).toBe('warn')
    expect(scan('x').findings).toHaveLength(0)
  })
})
