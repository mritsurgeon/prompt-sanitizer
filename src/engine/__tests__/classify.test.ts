import { describe, expect, it } from 'vitest'
import { classifyDocument } from '../classify'
import { scan } from '../detect'

/**
 * Three dimensions, three different questions. A signed NDA has no PII in it,
 * is obviously internal, and knowing it is *an NDA belonging to Legal* is what
 * tells a person how carefully to treat it.
 */

const NDA = `MUTUAL NON-DISCLOSURE AGREEMENT

This Agreement is made between two parties. The Receiving Party shall not
disclose any Confidential Information of the Disclosing Party. All intellectual
property and trade secrets remain the property of the Disclosing Party.
Governing law shall be England and Wales.`

const INVOICE = `TAX INVOICE

Invoice Number: INV-88213
Due date: 30 April 2027
Subtotal 12000.00
Total due 13800.00
Payment terms: 30 days. Remit to the bank details below.`

const SOW = `STATEMENT OF WORK

Scope of work: migration of the backup estate.
Deliverables and milestones are listed below, with acceptance criteria.
Out of scope: application refactoring.`

const PAYSLIP = `PAYSLIP

Gross pay 45000.00
Deductions 9200.00
Net pay 35800.00
Tax code 1257L. PAYE reference below.`

const MEETING = `Minutes of the meeting

Attendees: three people from the sales team.
Agenda and discussion below. Action items are listed with an owner and a due date.
Next meeting in two weeks.`

const SUPPORT = `Case Number: 49281

Severity: high. Reported by the customer this morning.
Steps to reproduce are below. The workaround is documented; root cause pending.
Escalated to the technical support team.`

const PRESS_RELEASE = `FOR IMMEDIATE RELEASE

Northwind Traders Ltd today announced general availability of its platform.
Available to all customers from today. All rights reserved.`

const CHITCHAT = `Hi team,

Can someone pick up the thing we discussed yesterday? I will be out until
Thursday. Thanks.`

describe('document type', () => {
  it.each([
    ['an NDA', NDA, 'nda'],
    ['an invoice', INVOICE, 'invoice'],
    ['a statement of work', SOW, 'sow'],
    ['a payslip', PAYSLIP, 'payslip'],
    ['meeting notes', MEETING, 'meeting_notes'],
    ['a support case', SUPPORT, 'support_case'],
  ])('identifies %s', (_label, text, expected) => {
    expect(classifyDocument(text).documentType?.id).toBe(expected)
  })

  it('prefers the more specific agreement type', () => {
    // The NDA also contains generic contract language.
    expect(classifyDocument(NDA).documentType?.id).toBe('nda')
  })

  it('declines to guess when there is nothing to go on', () => {
    expect(classifyDocument(CHITCHAT).documentType).toBeNull()
    expect(classifyDocument(PRESS_RELEASE).documentType).toBeNull()
  })

  it('uses the filename as supporting evidence', () => {
    const body = 'Deliverables and milestones are listed below.'
    const bare = classifyDocument(body)
    const named = classifyDocument(body, { filename: 'SOW_migration_2027.docx' })

    expect(named.documentType?.id).toBe('sow')
    expect(named.documentType!.confidence).toBeGreaterThan(
      bare.documentType?.confidence ?? 0,
    )
  })
})

describe('topic', () => {
  it('is multi-label', () => {
    const topics = classifyDocument(NDA).topics.map((t) => t.id)
    expect(topics).toContain('legal')
    expect(topics).toContain('ip')
  })

  it.each([
    ['finance', INVOICE, 'finance'],
    ['people and HR', PAYSLIP, 'hr'],
  ])('recognises %s', (_label, text, expected) => {
    expect(classifyDocument(text).topics.map((t) => t.id)).toContain(expected)
  })

  it('stays quiet on content with no clear subject', () => {
    expect(classifyDocument(CHITCHAT).topics).toHaveLength(0)
  })
})

describe('function', () => {
  it('reads a department named directly in the text', () => {
    const result = classifyDocument(
      'Please forward this to the procurement team for sourcing approval. The category manager will review supplier lead time.',
    )
    const direct = result.functions.find((f) => !f.inferred)
    expect(direct?.id).toBe('procurement_dept')
  })

  it('infers the owning function from the subject, and says so', () => {
    const result = classifyDocument(PAYSLIP)
    const fn = result.functions[0]

    expect(fn.id).toBe('hr_dept')
    expect(fn.inferred).toBe(true)
    expect(fn.evidence.join(' ')).toContain('inferred')
    // An inference must be less confident than the subject it came from.
    expect(fn.confidence).toBeLessThan(result.topics[0].confidence)
  })
})

describe('explainability', () => {
  it('gives plain-English evidence for every label', () => {
    const result = classifyDocument(NDA, { filename: 'nda-2027.docx' })
    const all = [
      ...result.topics,
      ...result.functions,
      ...(result.documentType ? [result.documentType] : []),
    ]

    expect(all.length).toBeGreaterThan(0)
    for (const item of all) {
      expect(item.evidence.length).toBeGreaterThan(0)
      expect(item.evidence.every((e) => e.length > 0)).toBe(true)
    }
  })

  it('summarises all three dimensions in one line', () => {
    const summary = classifyDocument(NDA).summary
    expect(summary).toContain('Non-disclosure agreement')
    expect(summary).toContain('Legal')
  })
})

describe('classification feeds sensitivity', () => {
  it('treats a confidently identified NDA as internal on its own', () => {
    // No classification markers, no roadmap vocabulary — only the fact that it
    // is unmistakably an NDA.
    expect(scan(SOW).document.state).not.toBe('general')
    expect(scan(NDA).document.state).not.toBe('general')
  })

  it('does not make routine documents sensitive', () => {
    expect(scan(INVOICE).document.state).toBe('general')
    expect(scan(PRESS_RELEASE).document.state).toBe('general')
    expect(scan(CHITCHAT).document.state).toBe('general')
  })

  it('keeps classification separate from PII findings', () => {
    const result = scan(NDA)
    // The NDA carries no personal data at all, yet is still classified.
    expect(result.findings.filter((f) => f.category === 'EMAIL')).toHaveLength(0)
    expect(result.classification.documentType?.id).toBe('nda')
  })
})

describe('cost', () => {
  it('classifies a large document without scanning all of it', () => {
    const big = `${NDA}\n${'filler text that says nothing at all. '.repeat(20000)}`
    const started = performance.now()
    const result = classifyDocument(big)
    const ms = performance.now() - started

    expect(result.documentType?.id).toBe('nda')
    expect(ms).toBeLessThan(50)
  })
})
