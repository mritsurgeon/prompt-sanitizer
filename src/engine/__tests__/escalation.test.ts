import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getLocalModel,
  registerLocalModel,
  resetLocalModel,
  type LocalModelDetector,
} from '../confirm'
import { scan, scanWithConfirmation } from '../detect'
import { sanitize } from '../sanitize'

/**
 * The selective escalation gate.
 *
 * The single most important property: the expensive path must not run when the
 * fast path already reached a confident conclusion.
 */

const UNAMBIGUOUS =
  'Email sarah.mitchell@example.com or call +27 82 555 0198 about CASE-49281.'

const AMBIGUOUS = 'Adeyemi confirmed the migration window this morning.'

/** A spy confirmer that records exactly what it was asked. */
function spyModel(
  decision: 'confirm' | 'reject' | 'unknown' = 'confirm',
): LocalModelDetector & {
  calls: { requests: number; windows: string[] }
  loads: number
} {
  const state = {
    calls: { requests: 0, windows: [] as string[] },
    loads: 0,
    loaded: false,
  }

  return {
    id: 'spy',
    label: 'Spy model',
    // Non-zero, so it is treated as a model with weights to load rather than a
    // free deterministic pass — which is what the cold-start gate keys on.
    cost: { bytes: 1_000_000, startupMs: 0, perCandidateMs: 0 },
    calls: state.calls,
    get loads() {
      return state.loads
    },
    get loaded() {
      return state.loaded
    },
    isAvailable: async () => true,
    load: async () => {
      state.loads += 1
      state.loaded = true
    },
    confirm: async (requests) => {
      state.calls.requests += requests.length
      state.calls.windows.push(...requests.map((r) => r.window))
      return requests.map((r) => ({
        id: r.id,
        decision,
        confidence: 0.95,
        note: 'spy verdict',
      }))
    },
  } as LocalModelDetector & {
    calls: { requests: number; windows: string[] }
    loads: number
  }
}

afterEach(() => {
  resetLocalModel()
})

describe('the gate', () => {
  it('does not invoke or load the model when nothing is ambiguous', async () => {
    const model = spyModel()
    registerLocalModel(model)

    const result = await scanWithConfirmation(UNAMBIGUOUS)

    expect(result.ambiguous).toHaveLength(0)
    expect(result.escalation.modelInvoked).toBe(false)
    expect(model.calls.requests).toBe(0)
    expect(model.loads).toBe(0)
  })

  it('invokes the model only for the ambiguous candidates', async () => {
    const model = spyModel()
    registerLocalModel(model)

    const fast = scan(`${UNAMBIGUOUS}\n${AMBIGUOUS}`)
    const result = await scanWithConfirmation(`${UNAMBIGUOUS}\n${AMBIGUOUS}`)

    expect(fast.ambiguous.length).toBeGreaterThan(0)
    expect(result.escalation.modelInvoked).toBe(true)
    // Only the ambiguous ones — not every finding in the text.
    expect(model.calls.requests).toBe(fast.ambiguous.length)
    expect(model.calls.requests).toBeLessThan(fast.findings.length)
    expect(model.loads).toBe(1)
  })

  it('sends a small window, not the whole document', async () => {
    const model = spyModel()
    registerLocalModel(model)

    const padding = 'This is ordinary filler text that carries nothing. '.repeat(60)
    const document = `${padding}\n${AMBIGUOUS}\n${padding}`

    await scanWithConfirmation(document)

    expect(model.calls.windows.length).toBeGreaterThan(0)
    for (const window of model.calls.windows) {
      expect(window.length).toBeLessThan(document.length / 2)
      expect(window).toContain('Adeyemi')
    }
  })

  it('promotes a confirmed finding to high confidence', async () => {
    registerLocalModel(spyModel('confirm'))
    const result = await scanWithConfirmation(AMBIGUOUS)

    const person = result.findings.find((f) => f.category === 'PERSON')
    expect(person?.tier).toBe('high')
    expect(person?.confirmedBy).toBe('spy')
    expect(person?.signals.some((s) => s.note.includes('spy verdict'))).toBe(true)
  })

  it('deletes a finding the confirmer rejects', async () => {
    // On people, companies and places the confirmer is a model trained on far
    // more text than any hand-written rule encodes. When the two disagree
    // about a name it is usually the rule guessing from shape, so the
    // confirmer wins.
    registerLocalModel(spyModel('reject'))
    const result = await scanWithConfirmation(AMBIGUOUS)

    expect(result.findings.find((f) => f.category === 'PERSON')).toBeUndefined()
    expect(result.escalation.rejected).toBe(1)
  })

  it('cannot overturn a category it was never asked about', async () => {
    // The model is only consulted on people, companies and places. A rejecting
    // confirmer must not be able to delete an email or a support case.
    registerLocalModel(spyModel('reject'))
    const result = await scanWithConfirmation(UNAMBIGUOUS)

    const categories = result.findings.map((f) => f.category)
    expect(categories).toContain('EMAIL')
    expect(categories).toContain('PHONE')
    expect(categories).toContain('CASE_ID')
  })

  it('lets the confirmer correct the category rather than the verdict', async () => {
    // The rules guess a category from shape alone, so an unrecognised
    // capitalised phrase arrives as a possible person whether it is one or not.
    const relabelling: LocalModelDetector = {
      id: 'relabeller',
      label: 'Relabeller',
      cost: { bytes: 0, startupMs: 0, perCandidateMs: 0 },
      loaded: true,
      isAvailable: async () => true,
      load: async () => {},
      confirm: async (requests) =>
        requests.map((r) => ({
          id: r.id,
          decision: 'confirm' as const,
          confidence: 0.95,
          category: 'ORGANISATION' as const,
        })),
    }
    registerLocalModel(relabelling)

    const result = await scanWithConfirmation(AMBIGUOUS)
    const found = result.findings.find((f) => f.value === 'Adeyemi')

    expect(found?.category).toBe('ORGANISATION')
    // Still detected, so still sanitized — only the label changed.
    expect(found?.tier).not.toBe('low')
  })

  it('keeps an unresolved finding, still marked uncertain', async () => {
    registerLocalModel(spyModel('unknown'))
    const result = await scanWithConfirmation(AMBIGUOUS)

    const person = result.findings.find((f) => f.category === 'PERSON')
    expect(person).toBeDefined()
    expect(person?.tier).toBe('medium')
    expect(result.escalation.unresolved).toBe(1)
  })
})

describe('recovering what the rules missed', () => {
  // One ambiguous finding (so the gate opens) plus one capitalised word no
  // gazetteer knows (so there is something to recover).
  const MIXED = 'Adeyemi confirmed the window. We reviewed Kaltrix yesterday.'

  it('offers unknown words the rules scored too low to show', () => {
    const fast = scan(MIXED)
    expect(fast.recoverable.map((f) => f.value)).toContain('Kaltrix')
    // Offered, but never shown as a finding on its own.
    expect(fast.findings.map((f) => f.value)).not.toContain('Kaltrix')
  })

  it('promotes a recovery candidate the confirmer vouches for', async () => {
    registerLocalModel(spyModel('confirm'))
    const result = await scanWithConfirmation(MIXED)

    expect(result.findings.map((f) => f.value)).toContain('Kaltrix')
    expect(result.escalation.recovered).toBeGreaterThan(0)
  })

  it('leaves a recovery candidate alone when the confirmer declines', async () => {
    registerLocalModel(spyModel('reject'))
    const result = await scanWithConfirmation(MIXED)

    expect(result.findings.map((f) => f.value)).not.toContain('Kaltrix')
  })

  it('will not load a cold model for recovery candidates alone', async () => {
    // The tracker has unknown capitalised words but nothing ambiguous, so
    // there is no conclusion to check — speculating is not worth a cold start.
    const model = spyModel()
    registerLocalModel(model)

    const text =
      'Delivered\nVBR 12.1.0.2131\n\n2\nBackup window termination for Unix Workloads\nPlanned after V13'
    const fast = scan(text)
    expect(fast.recoverable.length).toBeGreaterThan(0)
    expect(fast.ambiguous).toHaveLength(0)

    const result = await scanWithConfirmation(text)
    expect(result.escalation.modelInvoked).toBe(false)
    expect(model.loads).toBe(0)
  })
})

describe('safe degradation', () => {
  it('keeps fast-path findings when the model throws', async () => {
    const broken: LocalModelDetector = {
      id: 'broken',
      label: 'Broken model',
      cost: { bytes: 0, startupMs: null, perCandidateMs: null },
      loaded: false,
      isAvailable: async () => true,
      load: async () => {},
      confirm: async () => {
        throw new Error('inference exploded')
      },
    }
    registerLocalModel(broken)

    const result = await scanWithConfirmation(AMBIGUOUS)

    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.escalation.error).toContain('inference exploded')
  })

  it('keeps fast-path findings when the model cannot load', async () => {
    const unloadable: LocalModelDetector = {
      id: 'unloadable',
      label: 'Unloadable model',
      cost: { bytes: 0, startupMs: null, perCandidateMs: null },
      loaded: false,
      isAvailable: async () => true,
      load: async () => {
        throw new Error('out of memory')
      },
      confirm: async () => [],
    }
    registerLocalModel(unloadable)

    const result = await scanWithConfirmation(AMBIGUOUS)
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.escalation.error).toContain('out of memory')
  })

  it('skips a model that reports itself unavailable', async () => {
    const confirm = vi.fn()
    registerLocalModel({
      id: 'absent',
      label: 'Absent model',
      cost: { bytes: 0, startupMs: null, perCandidateMs: null },
      loaded: false,
      isAvailable: async () => false,
      load: async () => {},
      confirm,
    })

    const result = await scanWithConfirmation(AMBIGUOUS)
    expect(confirm).not.toHaveBeenCalled()
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it('ships a confirmer that needs no files and cannot fail to load', async () => {
    const model = getLocalModel()
    expect(model.cost.bytes).toBe(0)
    await expect(model.isAvailable()).resolves.toBe(true)
    await expect(model.load()).resolves.toBeUndefined()
  })
})

describe('user overrides survive escalation', () => {
  it('does not sanitize a finding the user switched off', async () => {
    const result = await scanWithConfirmation(UNAMBIGUOUS)
    const findings = result.findings.map((f) =>
      f.category === 'EMAIL' ? { ...f, enabled: false } : f,
    )

    const cleaned = sanitize(result.text, findings, { mode: 'redact' })

    expect(cleaned.text).toContain('sarah.mitchell@example.com')
    expect(cleaned.text).not.toContain('[EMAIL]')
    expect(cleaned.text).toContain('[PHONE]')
  })

  it('respects overrides on confirmed ambiguous findings too', async () => {
    registerLocalModel(spyModel('confirm'))
    const result = await scanWithConfirmation(AMBIGUOUS)

    const findings = result.findings.map((f) => ({ ...f, enabled: false }))
    const cleaned = sanitize(result.text, findings, { mode: 'redact' })

    expect(cleaned.text).toBe(AMBIGUOUS)
    expect(cleaned.replacements).toHaveLength(0)
  })
})
