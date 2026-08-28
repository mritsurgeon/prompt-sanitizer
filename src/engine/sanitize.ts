import { category } from './categories'
import type {
  CategoryId,
  Finding,
  Replacement,
  SanitizeMode,
  SanitizeResult,
} from './types'

/** Deterministic hash so the same value always gets the same stand-in. */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return Math.abs(h)
}

const pick = <T,>(pool: T[], seed: number, bump: number): T =>
  pool[(seed + bump) % pool.length]

const FIRST = [
  'Alex',
  'Jordan',
  'Taylor',
  'Morgan',
  'Casey',
  'Riley',
  'Avery',
  'Quinn',
  'Rowan',
  'Drew',
  'Harper',
  'Emerson',
]
const LAST = [
  'Taylor',
  'Brooks',
  'Rivera',
  'Bennett',
  'Hayes',
  'Clarke',
  'Foster',
  'Nolan',
  'Reeves',
  'Sandoval',
]
const COMPANIES = [
  'Northwind Traders',
  'Contoso',
  'Fabrikam',
  'Globex',
  'Blue Harbour Group',
  'Cygnus Logistics',
  'Vertex Foods',
  'Solstice Bank',
]
const PLACES = ['Springfield', 'Fairview', 'Rivertown', 'Lakeside', 'Norwood']
const HOSTS = [
  'APP-NODE-07',
  'DB-SRV-12',
  'WEB-EDGE-03',
  'FILE-STORE-05',
  'MAIL-RELAY-02',
  'BKP-REPO-09',
]
const PROJECTS = ['Aurora', 'Meridian', 'Lighthouse', 'Cobalt', 'Skyline']

const pad = (n: number, width = 4) => String(n).padStart(width, '0')

/**
 * Realistic-but-fictional stand-ins. Every value comes from a range reserved
 * for documentation and examples (example.com, 555-01xx, 203.0.113.0/24,
 * the 4111… test card) so a synthetic result can never collide with something
 * real.
 */
function synthetic(id: CategoryId, value: string, bump: number): string {
  const seed = hash(value)
  const n = (seed + bump) % 9000

  switch (id) {
    case 'PERSON':
      return `${pick(FIRST, seed, bump)} ${pick(LAST, seed, bump * 3)}`
    case 'EMAIL':
      return `${pick(FIRST, seed, bump).toLowerCase()}.${pick(LAST, seed, bump * 3).toLowerCase()}@example.com`
    case 'PHONE':
      return `+1 555 01${pad(n % 100, 2)}`
    case 'ORGANISATION':
      return pick(COMPANIES, seed, bump)
    case 'LOCATION':
      return pick(PLACES, seed, bump)
    case 'POSTAL_ADDRESS':
      return `${10 + (n % 80)} Example Street, ${pick(PLACES, seed, bump)}`
    case 'IP_ADDRESS':
      return `203.0.113.${10 + (n % 240)}`
    case 'MAC_ADDRESS':
      return `00:1B:44:11:3A:${(n % 256).toString(16).padStart(2, '0').toUpperCase()}`
    case 'INTERNAL_HOST':
      return pick(HOSTS, seed, bump)
    case 'NETWORK_PATH':
      return `\\\\${pick(HOSTS, seed, bump)}\\shared`
    case 'URL':
      return `https://example.com/page-${pad(n % 100, 2)}`
    case 'CUSTOMER_ID':
      return `CUST-${pad(100000 + n, 6)}`
    case 'CASE_ID':
      return `CASE-${pad(20000 + n, 5)}`
    case 'CONTRACT_ID':
      return `CTR-${pad(30000 + n, 5)}`
    case 'EMPLOYEE_ID':
      return `EMP-${pad(40000 + n, 5)}`
    case 'REFERENCE_ID':
      return `REF-${pad(50000 + n, 5)}`
    case 'PROJECT_CODE':
      return pick(PROJECTS, seed, bump)
    case 'RELEASE_PLAN':
      return `Q${1 + (n % 4)} 20${30 + (n % 5)}`
    case 'PRICING_TERM':
      return `${5 + (n % 20)}% discount`
    case 'LICENSE_KEY':
      return `EXMP-${pad(n, 4)}-${pad((n * 7) % 10000, 4)}-${pad((n * 13) % 10000, 4)}`
    case 'UUID':
      return `00000000-0000-4000-8000-${pad(n, 12)}`
    case 'CREDIT_CARD':
      return '4111 1111 1111 1111'
    case 'BANK_ACCOUNT':
      return 'GB29 NWBK 6016 1331 9268 19'
    case 'NATIONAL_ID':
      return `999-00-${pad(n % 10000, 4)}`
    default:
      return category(id).token
  }
}

export interface SanitizeOptions {
  mode: SanitizeMode
}

/**
 * Replaces every enabled finding, keeping one consistent stand-in per distinct
 * value so "Sarah" is the same person everywhere in the document.
 *
 * Secrets are the exception: passwords, keys and tokens are always removed
 * outright, in every mode. Handing back a realistic-looking credential would
 * only invite somebody to trust it.
 */
export function sanitize(
  text: string,
  findings: Finding[],
  { mode }: SanitizeOptions,
): SanitizeResult {
  const active = findings
    .filter((f) => f.enabled)
    .sort((a, b) => a.start - b.start)

  const assigned = new Map<string, string>()
  const used = new Set<string>()
  const counters = new Map<CategoryId, number>()

  const replacementFor = (finding: Finding): string => {
    const meta = category(finding.category)
    const key = `${finding.category}::${finding.value.toLowerCase().replace(/\s+/g, ' ')}`
    const cached = assigned.get(key)
    if (cached) return cached

    let result: string

    if (meta.group === 'secret' || mode === 'redact') {
      result = meta.token
    } else if (mode === 'pseudonymize') {
      const next = (counters.get(finding.category) ?? 0) + 1
      counters.set(finding.category, next)
      result = `${meta.pseudoPrefix}_${pad(next, 3)}`
    } else {
      let bump = 0
      result = synthetic(finding.category, finding.value, bump)
      while (used.has(result) && bump < 50) {
        bump += 1
        result = synthetic(finding.category, finding.value, bump)
      }
    }

    assigned.set(key, result)
    used.add(result)
    return result
  }

  let out = ''
  let cursor = 0
  const replacements: Replacement[] = []
  const valueMap = new Map<string, string>()

  for (const finding of active) {
    if (finding.start < cursor) continue // defensive: overlaps are pre-resolved
    const replacement = replacementFor(finding)

    out += text.slice(cursor, finding.start)
    const start = out.length
    out += replacement
    cursor = finding.end

    replacements.push({
      finding,
      replacement,
      start,
      end: out.length,
    })
    valueMap.set(finding.value, replacement)
  }

  out += text.slice(cursor)

  return { text: out, replacements, valueMap }
}

/** Used by the details list: "john@acme.com → [EMAIL]". */
export function previewReplacement(
  finding: Finding,
  mode: SanitizeMode,
): string {
  const meta = category(finding.category)
  if (meta.group === 'secret' || mode === 'redact') return meta.token
  if (mode === 'pseudonymize') return `${meta.pseudoPrefix}_001`
  return synthetic(finding.category, finding.value, 0)
}

export const MODE_COPY: Record<
  SanitizeMode,
  { label: string; hint: string }
> = {
  redact: {
    label: 'Placeholders',
    hint: 'Sensitive values become labels like [EMAIL]. Clearest for the AI.',
  },
  pseudonymize: {
    label: 'Nicknames',
    hint: 'Each value becomes a consistent stand-in like Person_001, so the AI can still follow who is who.',
  },
  synthetic: {
    label: 'Realistic fakes',
    hint: 'Values are swapped for believable but invented ones. Remember the result is made up.',
  },
}
