// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { digestFor, isAllowed, resetAllowlist, suppressAllowed } from '@/engine/allowlist'
import { DEFAULT_POLICY, OBSERVE_ONLY, evaluate } from '@/engine/policy'
import { scan } from '@/engine/detect'
import type { Candidate } from '@/engine/types'

/**
 * Enterprise configuration.
 *
 * The rule the whole design turns on: the schema uses the engine's own
 * vocabulary. `policy.ts` already names four groups and three decisions, so a
 * managed key maps onto one by assignment rather than by translation — and a
 * translation layer is exactly where a schema and an engine drift apart until
 * nobody can say what an administrator's policy actually did.
 *
 * The second rule: a policy is pushed by somebody who cannot see the result,
 * so a wrong value must degrade to the default and never to `allow`.
 */

const store = { managed: {} as Record<string, unknown>, local: {} as Record<string, unknown> }

const area = (bag: Record<string, unknown>) => ({
  get: async (key: string | null) => (key === null ? { ...bag } : { [key]: bag[key] }),
  set: async (items: Record<string, unknown>) => void Object.assign(bag, items),
  remove: async () => {},
})

const chromeStub = {
  storage: { managed: area(store.managed), local: area(store.local) },
  tabs: { onRemoved: { addListener: () => {} } },
  runtime: { lastError: undefined, sendMessage: () => undefined },
}

let managed: typeof import('../managed')
let allowlist: typeof import('../allowlist')

beforeAll(async () => {
  vi.stubGlobal('chrome', chromeStub)
  managed = await import('../managed')
  allowlist = await import('../allowlist')
})

beforeEach(() => {
  store.managed = {}
  store.local = {}
  chromeStub.storage.managed = area(store.managed)
  chromeStub.storage.local = area(store.local)
  resetAllowlist()
})

describe('an unmanaged browser', () => {
  it('is the common case, and gets the defaults exactly', async () => {
    expect(await managed.readManaged()).toBeNull()
    const resolved = managed.resolveManaged(null)

    // Absent is not an error. It has to fall through to the conservative
    // defaults rather than to anything more permissive.
    expect(resolved.policy).toEqual(DEFAULT_POLICY)
    expect(resolved.managed).toBe(false)
    expect(resolved.observeOnly).toBe(false)
    expect(resolved.allowUserOverrides).toBe(true)
    expect(resolved.managedAllowlist).toBeNull()
  })

  it('treats an empty managed namespace as unmanaged', () => {
    expect(managed.resolveManaged({})).toEqual(managed.UNMANAGED)
  })
})

describe('the schema speaks the engine’s vocabulary', () => {
  it('maps each group onto a decision by assignment', () => {
    const { policy } = managed.resolveManaged({
      Secret: 'block',
      Personal: 'block',
      Confidential: 'warn',
      Internal: 'allow',
      UncertainCeiling: 'warn',
      OnEngineUnavailable: 'block',
    })
    // No translation step, so there is nothing to drift.
    expect(policy).toEqual({
      secret: 'block',
      personal: 'block',
      confidential: 'warn',
      internal: 'allow',
      uncertainCeiling: 'warn',
      onEngineUnavailable: 'block',
    })
  })

  it('selects a base and lets the groups override it', () => {
    // An admin who only wants audit mode sets one key; one who wants to watch
    // everything but still stop credentials sets two.
    const { policy, observeOnly } = managed.resolveManaged({
      ExecutionMode: 'OBSERVE_ONLY',
      Secret: 'block',
    })
    expect(policy.personal).toBe(OBSERVE_ONLY.personal)
    expect(policy.secret).toBe('block')
    // Still enforces something, so it is not audit mode any more.
    expect(observeOnly).toBe(false)
  })

  it('reports observe-only only when nothing at all would interrupt', () => {
    expect(managed.resolveManaged({ ExecutionMode: 'OBSERVE_ONLY' }).observeOnly).toBe(true)
    expect(managed.resolveManaged({ ExecutionMode: 'ENFORCE' }).observeOnly).toBe(false)
  })

  it('ignores a value that is not a decision, rather than coercing it', () => {
    const { policy } = managed.resolveManaged({
      Secret: 'BLOCK' as never,
      Personal: 'quarantine' as never,
      Internal: true as never,
    })
    // A typo in a pushed policy must degrade to the default and never to
    // `allow` — the administrator cannot see the result.
    expect(policy.secret).toBe(DEFAULT_POLICY.secret)
    expect(policy.personal).toBe(DEFAULT_POLICY.personal)
    expect(policy.internal).toBe(DEFAULT_POLICY.internal)
  })
})

describe('the policy actually changes what happens', () => {
  const findings = () => scan('Email sarah.mitchell@example.com about it').findings

  it('warns on personal data by default and allows it in audit mode', () => {
    expect(evaluate({ findings: findings() }, DEFAULT_POLICY).decision).toBe('warn')
    const { policy } = managed.resolveManaged({ ExecutionMode: 'OBSERVE_ONLY' })
    expect(evaluate({ findings: findings() }, policy).decision).toBe('allow')
  })

  it('can watch personal data while still blocking credentials', () => {
    const { policy } = managed.resolveManaged({
      ExecutionMode: 'OBSERVE_ONLY',
      Secret: 'block',
    })
    expect(evaluate({ findings: findings() }, policy).decision).toBe('allow')

    const secret = scan('key AKIAIOSFODNN7EXAMPLE rotated').findings
    expect(evaluate({ findings: secret }, policy).decision).toBe('block')
  })
})

describe('the managed allowlist', () => {
  const SALT = 'corp-salt'

  it('is loaded from digests, and domains stay domains', () => {
    const resolved = managed.resolveManaged({
      AllowlistSalt: SALT,
      AllowlistDigests: [digestFor('Acme Holdings', SALT)],
      AllowlistDomainDigests: [digestFor('corp.internal', SALT)],
    })

    expect(resolved.managedAllowlist).not.toBeNull()
    const list = resolved.managedAllowlist!
    expect(isAllowed({ value: 'Acme Holdings', category: 'ORGANISATION' }, list)).toBe(true)
    // Merging both digest lists into one set — which the obvious draft does —
    // breaks suffix matching entirely: `api.corp.internal` would then only
    // match if the whole host had been listed.
    expect(isAllowed({ value: 'api.corp.internal', category: 'INTERNAL_HOST' }, list)).toBe(
      true,
    )
  })

  it('is null when policy pushed no list', () => {
    expect(managed.resolveManaged({ Secret: 'block' }).managedAllowlist).toBeNull()
  })

  it('honours a user list alongside it, each with its own salt', async () => {
    store.managed = {
      AllowlistSalt: SALT,
      AllowlistDigests: [digestFor('Acme Holdings', SALT)],
    }
    store.local = {
      allowlist: {
        salt: 'user-salt',
        valueDigests: [digestFor('Ian Engelbrecht', 'user-salt')],
      },
    }
    chromeStub.storage.managed = area(store.managed)
    chromeStub.storage.local = area(store.local)

    const resolved = managed.resolveManaged(await managed.readManaged())
    expect(await allowlist.installAllowlist(resolved)).toBe(2)

    // Two salts, so one merged set cannot express it: a digest only means
    // anything against the salt it was made with.
    const candidates = [
      { value: 'Acme Holdings', category: 'ORGANISATION' },
      { value: 'Ian Engelbrecht', category: 'PERSON' },
      { value: 'Thandeka Mokoena', category: 'PERSON' },
    ] as Candidate[]
    const { kept } = suppressAllowed(candidates)
    expect(kept.map((c) => c.value)).toEqual(['Thandeka Mokoena'])
  })

  it('drops the user list when overrides are forbidden', async () => {
    store.managed = {
      AllowUserOverrides: false,
      AllowlistSalt: SALT,
      AllowlistDigests: [digestFor('Acme Holdings', SALT)],
    }
    store.local = {
      allowlist: {
        salt: 'user-salt',
        valueDigests: [digestFor('Ian Engelbrecht', 'user-salt')],
      },
    }
    chromeStub.storage.managed = area(store.managed)
    chromeStub.storage.local = area(store.local)

    const resolved = managed.resolveManaged(await managed.readManaged())
    expect(resolved.allowUserOverrides).toBe(false)
    expect(await allowlist.installAllowlist(resolved)).toBe(1)

    const candidates = [
      { value: 'Acme Holdings', category: 'ORGANISATION' },
      { value: 'Ian Engelbrecht', category: 'PERSON' },
    ] as Candidate[]
    // An organisation that has decided which identities may be suppressed has
    // not left the rest open.
    expect(suppressAllowed(candidates).kept.map((c) => c.value)).toEqual([
      'Ian Engelbrecht',
    ])
  })

  it('cannot silence a credential, even by policy', () => {
    const resolved = managed.resolveManaged({
      AllowlistSalt: SALT,
      AllowlistDigests: [digestFor('AKIAIOSFODNN7EXAMPLE', SALT)],
    })
    // Not a matter of configuration. An administrator cannot switch off
    // credential detection through the allowlist, by accident or otherwise.
    expect(
      isAllowed({ value: 'AKIAIOSFODNN7EXAMPLE', category: 'API_KEY' }, resolved.managedAllowlist!),
    ).toBe(false)
  })
})
