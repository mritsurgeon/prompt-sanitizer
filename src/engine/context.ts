import {
  AMBIGUOUS_GIVEN_NAMES,
  COMMON_NOUN_FOLLOWERS,
  DETERMINER_BEFORE,
  FUNCTION_FOLLOWERS,
  JOB_TITLE_RE,
  LOCATIVE_BEFORE,
  PERSON_VERBS,
  PUBLIC_URL_PATHS,
  ROLE_CONTEXT_RE,
} from './lexicon'
import type {
  Candidate,
  DocumentSensitivity,
  Finding,
  Signal,
  Tier,
} from './types'

/**
 * Layer 2 — the context and confidence engine.
 *
 * A detector says "this *could* be a person". This decides whether the
 * surrounding language actually supports that reading. Crucially it looks for
 * evidence in both directions: "Christian joined the meeting" and "Christian
 * values are important" produce the same candidate and must not produce the
 * same answer.
 *
 * Every adjustment is recorded as a `Signal`, so the number the engine
 * produces can always be explained in plain English.
 */

/** Above this, act on it. */
export const HIGH_THRESHOLD = 0.8
/** Above this, show it but mark it uncertain — and consider escalating. */
export const MEDIUM_THRESHOLD = 0.55

export function tierFor(confidence: number): Tier {
  if (confidence >= HIGH_THRESHOLD) return 'high'
  if (confidence >= MEDIUM_THRESHOLD) return 'medium'
  return 'low'
}

export interface DocumentIndex {
  /** Words that appear in lower case somewhere in the document. */
  lowercaseWords: Set<string>
  /** Name-shaped fragments taken from email local parts. */
  emailFragments: Set<string>
  /** Tokens belonging to names we are already confident about. */
  strongPersonTokens: Set<string>
  sensitivity?: DocumentSensitivity
}

const LOWERCASE_WORD_RE = /\b[a-z][a-z'-]{2,}\b/g

/**
 * Categories whose text is machine-readable rather than natural language.
 * Their contents must not count as "this word is used in lower case", because
 * `christian@example.com` is evidence *for* a person named Christian, not
 * evidence that "christian" is an ordinary lowercase word.
 */
const NON_PROSE: Set<string> = new Set([
  'EMAIL',
  'URL',
  'CONNECTION_STRING',
  'API_KEY',
  'ACCESS_TOKEN',
  'PRIVATE_KEY',
  'NETWORK_PATH',
  'INTERNAL_HOST',
  'UUID',
])

export function buildIndex(
  text: string,
  candidates: Candidate[],
  sensitivity?: DocumentSensitivity,
): DocumentIndex {
  // Blank out identifiers before looking for lowercase prose.
  let prose = text
  for (const candidate of candidates) {
    if (!NON_PROSE.has(candidate.category)) continue
    prose =
      prose.slice(0, candidate.start) +
      ' '.repeat(candidate.end - candidate.start) +
      prose.slice(candidate.end)
  }

  const lowercaseWords = new Set<string>()
  for (const match of prose.matchAll(LOWERCASE_WORD_RE)) {
    lowercaseWords.add(match[0])
  }

  const emailFragments = new Set<string>()
  const strongPersonTokens = new Set<string>()

  for (const candidate of candidates) {
    if (candidate.category === 'EMAIL') {
      const local = candidate.value.split('@')[0] ?? ''
      for (const part of local.toLowerCase().split(/[._+\-\d]+/)) {
        if (part.length >= 3) emailFragments.add(part)
      }
    }
    // A full "given name + known surname" is strong enough to vouch for its
    // own tokens appearing alone elsewhere in the same document.
    if (candidate.category === 'PERSON' && candidate.base >= 0.9) {
      for (const token of candidate.value.toLowerCase().split(/\s+/)) {
        if (token.length >= 3) strongPersonTokens.add(token)
      }
    }
  }

  return { lowercaseWords, emailFragments, strongPersonTokens, sensitivity }
}

// ---------------------------------------------------------------------------
// Local text helpers
// ---------------------------------------------------------------------------

function precedingWord(text: string, index: number): string {
  const match = text
    .slice(Math.max(0, index - 60), index)
    .match(/([A-Za-z]+)[ \t]*$/)
  return match ? match[1].toLowerCase() : ''
}

/**
 * The rest of the line after `index`. Context must not cross a line break: in
 * a table or a bulleted list the next line is a different record entirely, and
 * treating its first word as context produces nonsense like reading "Unix
 * Workloads" as a person because the next row happens to start "Planned".
 */
function restOfLine(text: string, index: number): string {
  const rest = text.slice(index)
  const newline = rest.search(/[\r\n]/)
  return newline === -1 ? rest : rest.slice(0, newline)
}

function followingWord(line: string): string {
  const match = line.match(/^[ \t,)]*([A-Za-z']+)/)
  return match ? match[1].toLowerCase() : ''
}

function startsSentence(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd()
  return before.length === 0 || /[.!?:;]$/.test(before) || /\n\s*$/.test(text.slice(0, index))
}

const signal = (id: string, weight: number, note: string): Signal => ({
  id,
  weight,
  note,
})

// ---------------------------------------------------------------------------
// Per-category context rules
// ---------------------------------------------------------------------------

/**
 * People are where almost all the ambiguity lives, so this rule set does the
 * most work. Preceding and following context are each evaluated once and
 * contribute a single signal, so a phrase cannot be counted twice.
 */
function personSignals(
  text: string,
  candidate: Candidate,
  index: DocumentIndex,
): Signal[] {
  const signals: Signal[] = []
  const soft = candidate.singleToken || candidate.unresolved
  const before = precedingWord(text, candidate.start)
  const after = restOfLine(text, candidate.end)
  const nextWord = followingWord(after)

  // ---- preceding context (one signal) ------------------------------------
  let positiveBefore = false

  if (/^(?:mr|mrs|ms|miss|dr|prof|sir|madam|mnr|mev|dhr)$/.test(before)) {
    signals.push(signal('title', 0.3, `Introduced by the title "${before}"`))
    positiveBefore = true
  } else if (PERSON_CUE_WORDS.has(before)) {
    const weight = candidate.unresolved ? 0.3 : 0.2
    signals.push(signal('person-cue', weight, `Follows "${before}", which usually introduces a person`))
    positiveBefore = true
  } else if (soft && DETERMINER_BEFORE.has(before)) {
    signals.push(
      signal('determiner-before', -0.25, `Preceded by "${before}", so it reads as an ordinary word`),
    )
  }

  // ---- following context (one signal) ------------------------------------
  if (ROLE_CONTEXT_RE.test(after)) {
    signals.push(signal('role-context', 0.4, 'Followed by a team or department, as a person would be'))
  } else if (JOB_TITLE_RE.test(after)) {
    signals.push(signal('job-title', 0.3, 'Followed by a job title'))
  } else if (/^['’]s\b/.test(after)) {
    signals.push(signal('possessive', 0.18, 'Used possessively, as a person would be'))
  } else if (PERSON_VERBS.has(nextWord)) {
    signals.push(signal('person-verb', 0.4, `Followed by "${nextWord}", something a person does`))
  } else if (!positiveBefore && soft && COMMON_NOUN_FOLLOWERS.has(nextWord)) {
    signals.push(
      signal('common-noun-after', -0.25, `Followed by "${nextWord}", so it reads as a description`),
    )
  } else if (!positiveBefore && soft && FUNCTION_FOLLOWERS.has(nextWord)) {
    signals.push(
      signal('function-word-after', -0.25, `Followed by "${nextWord}", so it reads as ordinary language`),
    )
  } else if (!positiveBefore && soft && nextWord) {
    signals.push(signal('no-person-context', -0.1, 'Nothing nearby suggests a person'))
  }

  // ---- the surface form itself -------------------------------------------
  // Only penalise ambiguity when a gazetteer actually vouched for the word as
  // a given name. An unresolved token already starts from a low base, and
  // charging it twice for the same uncertainty buries real names.
  if (
    candidate.singleToken &&
    !candidate.unresolved &&
    AMBIGUOUS_GIVEN_NAMES.has(candidate.value.toLowerCase())
  ) {
    signals.push(
      signal('ambiguous-word', -0.3, `"${candidate.value}" is also an everyday word`),
    )
  }

  // "Unix Workloads", "Feature Request Tracker" — a capitalised phrase nobody
  // recognises that contains an ordinary English noun is a product or a
  // feature, not somebody's name.
  if (candidate.unresolved && !candidate.singleToken) {
    const ordinary = candidate.value
      .toLowerCase()
      .split(/\s+/)
      .find((token) => COMMON_NOUN_FOLLOWERS.has(token))
    if (ordinary) {
      signals.push(
        signal(
          'common-noun-inside',
          -0.3,
          `"${ordinary}" is an everyday word, so this reads as a thing rather than a person`,
        ),
      )
    }
  }

  if (soft && startsSentence(text, candidate.start)) {
    signals.push(
      signal('sentence-start', -0.15, 'Capitalised only because it starts a sentence'),
    )
  }

  // ---- document-wide evidence --------------------------------------------
  const lower = candidate.value.toLowerCase()

  if (candidate.singleToken && index.lowercaseWords.has(lower)) {
    signals.push(
      signal(
        'lowercase-elsewhere',
        -0.35,
        `The same word appears in lower case elsewhere, so it is probably ordinary language`,
      ),
    )
  }

  for (const token of lower.split(/\s+/)) {
    if (index.emailFragments.has(token)) {
      signals.push(
        signal('identity-link', 0.3, 'The same name appears in an email address in this content'),
      )
      break
    }
  }

  if (candidate.singleToken && index.strongPersonTokens.has(lower)) {
    signals.push(
      signal('known-person-token', 0.25, 'Part of a full name used elsewhere in this content'),
    )
  }

  return signals
}

const PERSON_CUE_WORDS = new Set([
  'contact',
  'user',
  'employee',
  'colleague',
  'engineer',
  'technician',
  'manager',
  'attention',
  'regards',
  'from',
  'by',
  'assigned',
  'reported',
  'raised',
  'called',
  'spoke',
  'met',
  'thanks',
  'hi',
  'hello',
  'dear',
])

function organisationSignals(
  text: string,
  candidate: Candidate,
  index: DocumentIndex,
): Signal[] {
  const signals: Signal[] = []
  const before = precedingWord(text, candidate.start)

  if (candidate.singleToken && DETERMINER_BEFORE.has(before) && candidate.base < 0.85) {
    signals.push(
      signal('determiner-before', -0.2, `Preceded by "${before}", so it reads as ordinary language`),
    )
  }

  if (candidate.singleToken && index.lowercaseWords.has(candidate.value.toLowerCase())) {
    signals.push(
      signal('lowercase-elsewhere', -0.3, 'The same word appears in lower case elsewhere'),
    )
  }

  return signals
}

function locationSignals(text: string, candidate: Candidate): Signal[] {
  const signals: Signal[] = []
  const before = precedingWord(text, candidate.start)
  const nextWord = followingWord(restOfLine(text, candidate.end))

  if (LOCATIVE_BEFORE.has(before)) {
    signals.push(
      signal('locative', 0.2, `Follows "${before}", so it names an actual place`),
    )
  } else if (DETERMINER_BEFORE.has(before)) {
    signals.push(
      signal('determiner-before', -0.25, `Preceded by "${before}", so it is describing something`),
    )
  }

  if (COMMON_NOUN_FOLLOWERS.has(nextWord)) {
    signals.push(
      signal('common-noun-after', -0.25, `Followed by "${nextWord}" — a general reference, not an address`),
    )
  }

  return signals
}

function urlSignals(candidate: Candidate): Signal[] {
  const value = candidate.value
  const hasQuery = value.includes('?') || value.includes('#')
  const segments = value.split('/').slice(3)
  const looksTokenised = segments.some((s) => s.length >= 20 && /\d/.test(s) && /[a-z]/i.test(s))
  const publicPath = segments.some((s) => PUBLIC_URL_PATHS.has(s.toLowerCase()))

  if (!hasQuery && !looksTokenised && (publicPath || segments.length <= 2)) {
    return [
      signal(
        'public-link',
        -0.45,
        'An ordinary public web link with nothing identifying in it',
      ),
    ]
  }
  if (hasQuery || looksTokenised) {
    return [signal('link-carries-data', 0.05, 'The link carries parameters that may identify someone')]
  }
  return []
}

const YEAR_RE = /-(19|20)\d{2}$/

function referenceSignals(candidate: Candidate): Signal[] {
  if (YEAR_RE.test(candidate.value)) {
    return [
      signal(
        'year-like',
        -0.3,
        'The number looks like a year, so this is probably a period rather than a reference',
      ),
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const clamp = (n: number) => Math.max(0, Math.min(1, n))

export interface AssessedCandidate extends Candidate {
  confidence: number
  tier: Tier
  allSignals: Signal[]
}

/**
 * Scores every candidate, then makes a second pass so that entities which
 * corroborate each other reinforce each other — the "entity consistency" step.
 */
export function assessCandidates(
  text: string,
  candidates: Candidate[],
  index: DocumentIndex,
): AssessedCandidate[] {
  const scored: AssessedCandidate[] = candidates.map((candidate) => {
    const contextual: Signal[] = []

    switch (candidate.category) {
      case 'PERSON':
        contextual.push(...personSignals(text, candidate, index))
        break
      case 'ORGANISATION':
        contextual.push(...organisationSignals(text, candidate, index))
        break
      case 'LOCATION':
        contextual.push(...locationSignals(text, candidate))
        break
      case 'URL':
        contextual.push(...urlSignals(candidate))
        break
      case 'REFERENCE_ID':
        contextual.push(...referenceSignals(candidate))
        break
      default:
        break
    }

    // Document context: in a document that already reads as internal, an
    // internal-looking identifier is a little more likely to be the real thing.
    if (
      index.sensitivity &&
      index.sensitivity.state !== 'general' &&
      (candidate.category === 'PROJECT_CODE' ||
        candidate.category === 'RELEASE_PLAN' ||
        candidate.category === 'PRICING_TERM')
    ) {
      contextual.push(
        signal('document-internal', 0.1, 'The surrounding document already reads as internal'),
      )
    }

    const allSignals = [...(candidate.signals ?? []), ...contextual]
    const confidence = clamp(
      candidate.base + allSignals.reduce((sum, s) => sum + s.weight, 0),
    )

    return { ...candidate, confidence, tier: tierFor(confidence), allSignals }
  })

  // ---- entity consistency ------------------------------------------------
  // If one mention of a value is confident, other mentions of the same value
  // in the same document inherit some of that confidence.
  const best = new Map<string, number>()
  for (const item of scored) {
    const key = `${item.category}::${item.value.toLowerCase()}`
    best.set(key, Math.max(best.get(key) ?? 0, item.confidence))
  }

  for (const item of scored) {
    const key = `${item.category}::${item.value.toLowerCase()}`
    const peak = best.get(key) ?? 0
    if (peak >= HIGH_THRESHOLD && item.confidence < HIGH_THRESHOLD) {
      item.allSignals = [
        ...item.allSignals,
        signal(
          'consistent-mention',
          0.15,
          'The same value is clearly sensitive elsewhere in this content',
        ),
      ]
      item.confidence = clamp(item.confidence + 0.15)
      item.tier = tierFor(item.confidence)
    }
  }

  return scored
}

/** Turns an assessed candidate into a finding. */
export function toFinding(
  item: AssessedCandidate,
  id: string,
  confirmedBy?: string,
): Finding {
  return {
    id,
    category: item.category,
    value: item.value,
    start: item.start,
    end: item.end,
    confidence: item.confidence,
    tier: item.tier,
    layer: item.layer,
    rule: item.rule,
    signals: item.allSignals,
    enabled: true,
    confirmedBy,
  }
}
