import { describe, expect, it } from 'vitest'
import { scan } from '../detect'
import { assessDocument } from '../documentSensitivity'

/**
 * Document sensitivity is a different question from "is this PII?" — a Q4
 * roadmap with no names in it is the case that matters. These tests pin the
 * three properties that keep the engine honest: multi-signal, contrary
 * evidence, and never claiming certainty.
 */

const ROADMAP = `Q4 Product Roadmap — internal use only

Project Phoenix will introduce inline deduplication. Internal beta begins in October.
General availability is targeted for Q2 2027 and the release schedule is still moving.
Pricing remains under review; the list price and gross margin are being modelled.`

const ARCHITECTURE = `High-level design

The data flow between the internal API and the service mesh is described below.
The database schema and failover design are covered in the appendix.`

const PRICING = `Rate card review

The list price increases and the gross margin target is under discussion.
Deal desk approval is needed for any discount above the usual threshold.
Our forecast and sales pipeline both assume the new rate card.`

const CONFIDENTIALITY_POLICY = `Confidentiality Policy

All employees must protect confidential information belonging to the company.
This policy is published on the intranet and applies to everyone.`

const PRESS_RELEASE = `FOR IMMEDIATE RELEASE

Northwind Traders Ltd today announced general availability of its new platform.
The product is available to all customers from today. All rights reserved.`

const KEYWORD_ONLY = `CONFIDENTIAL

Please review the attached notes before the call tomorrow.`

const ORDINARY_EMAIL = `Hi team,

Please look at the backup failure on the reporting server when you get a chance.
I have attached the log. Thanks.`

const assess = (text: string, filename?: string) =>
  assessDocument(text, filename ? { filename } : {}, scan(text).findings)

describe('company confidential detection', () => {
  it('flags a roadmap that mixes unreleased plans, pricing and a marker', () => {
    const result = assess(ROADMAP)
    expect(result.state).toBe('sensitive')
    expect(result.headline).toBe('Potential company confidential information')
    expect(result.topics.length).toBeGreaterThanOrEqual(2)
  })

  it('flags an internal design document on architecture signals alone', () => {
    const result = assess(ARCHITECTURE)
    expect(result.state).not.toBe('general')
    expect(result.summary).toContain('internal architecture')
  })

  it('flags a pricing review as at least possibly internal', () => {
    const result = assess(PRICING)
    expect(['internal', 'sensitive']).toContain(result.state)
  })

  it('does not need any PII to reach a conclusion', () => {
    // The roadmap contains no names, emails or numbers of any kind.
    const findings = scan(ROADMAP).findings
    const personal = findings.filter(
      (f) => f.category === 'EMAIL' || f.category === 'PHONE',
    )
    expect(personal).toHaveLength(0)
    expect(assess(ROADMAP).state).toBe('sensitive')
  })
})

describe('refusing to be keyword-only', () => {
  it('does not classify on a single marker word', () => {
    const result = assess(KEYWORD_ONLY)
    expect(result.state).toBe('general')
  })

  it('does not treat a published confidentiality policy as confidential', () => {
    const result = assess(CONFIDENTIALITY_POLICY)
    expect(result.state).toBe('general')
  })

  it('does not flag a press release, despite release language', () => {
    const result = assess(PRESS_RELEASE)
    expect(result.state).toBe('general')
  })

  it('leaves ordinary working text alone', () => {
    const result = assess(ORDINARY_EMAIL)
    expect(result.state).toBe('general')
    expect(result.confidence).toBeLessThan(0.35)
  })
})

describe('metadata signals', () => {
  it('takes the filename into account', () => {
    const plain = assess(PRICING)
    const named = assess(PRICING, 'FY2027 pricing strategy - internal.xlsx')
    expect(named.confidence).toBeGreaterThan(plain.confidence)
  })

  it('reads worksheet names as metadata', () => {
    const text = 'Item | Quarter | Value\nInline dedupe | Q3 2027 | 1450000'
    const bare = assessDocument(text, {})
    const withSheets = assessDocument(text, {
      sheetNames: ['Q4 Roadmap', 'Internal pricing'],
    })
    expect(withSheets.confidence).toBeGreaterThan(bare.confidence)
  })
})

describe('honesty of the wording', () => {
  it('never claims certainty', () => {
    for (const text of [ROADMAP, ARCHITECTURE, PRICING]) {
      const result = assess(text)
      expect(result.headline.toLowerCase()).toMatch(/potential|possibly/)
      expect(result.headline.toLowerCase()).not.toMatch(/definitely|certainly/)
    }
  })

  it('explains itself in plain English', () => {
    const result = assess(ROADMAP)
    expect(result.signals.length).toBeGreaterThan(0)
    expect(result.signals.every((s) => s.note.length > 0)).toBe(true)
    expect(result.summary.length).toBeGreaterThan(20)
  })
})

describe('span-level company IP findings', () => {
  it('finds internal project names, release dates and pricing terms', () => {
    const findings = scan(
      'Project Phoenix ships in March 2027 with a 15% discount for launch partners.',
    ).findings

    const categories = findings.map((f) => f.category)
    expect(categories).toContain('PROJECT_CODE')
    expect(categories).toContain('RELEASE_PLAN')
    expect(categories).toContain('PRICING_TERM')
  })

  it('keeps company IP separate from personal data', () => {
    const findings = scan(
      'Project Phoenix is led by Sarah Mitchell (sarah.mitchell@example.com).',
    ).findings

    const groups = new Set(
      findings.map((f) =>
        f.category === 'PROJECT_CODE' ? 'confidential' : 'other',
      ),
    )
    expect(groups.has('confidential')).toBe(true)
    expect(findings.some((f) => f.category === 'PERSON')).toBe(true)
    expect(findings.some((f) => f.category === 'EMAIL')).toBe(true)
  })
})
