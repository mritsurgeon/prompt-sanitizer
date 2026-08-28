import {
  AMBIGUOUS_GIVEN_NAMES,
  COMMON_NOUN_FOLLOWERS,
  FUNCTION_FOLLOWERS,
  PERSON_VERBS,
} from '../lexicon'
import type {
  ConfirmationRequest,
  ConfirmationVerdict,
  LocalModelDetector,
} from './types'

/**
 * The confirmer that ships by default: a deterministic deep-context pass.
 *
 * Layer 2 is deliberately cheap — it looks at the word either side of a
 * candidate and a few document-wide sets, because it runs over every candidate
 * in the document. This runs only over the handful that came back ambiguous,
 * which buys it the budget to do work that would be wasteful at scale:
 *
 *  - it examines *every* occurrence of the value in the content, not just this
 *    one, and votes across them;
 *  - it reads the whole surrounding clause rather than the adjacent word, so
 *    "Christian, who joined yesterday, said..." is resolvable;
 *  - it looks for third-person pronouns agreeing with the candidate;
 *  - it checks whether the value is ever used in lower case or in an
 *    unmistakably adjectival position.
 *
 * No weights, no download, no network, and it cannot fail to load.
 */

const CLAUSE_SPLIT_RE = /[.!?;\n]/

/** The clause containing `offset`, which is where agreement actually lives. */
function clauseAround(window: string, offset: number): string {
  let start = 0
  let end = window.length
  for (let i = offset - 1; i >= 0; i--) {
    if (CLAUSE_SPLIT_RE.test(window[i])) {
      start = i + 1
      break
    }
  }
  for (let i = offset; i < window.length; i++) {
    if (CLAUSE_SPLIT_RE.test(window[i])) {
      end = i
      break
    }
  }
  return window.slice(start, end)
}

const PRONOUNS = /\b(?:he|she|they|him|her|them|his|hers|their)\b/i
const PERSON_ROLE =
  /\b(?:manager|engineer|director|analyst|consultant|administrator|technician|colleague|customer|client|contact|owner|lead|architect|specialist|representative|advisor|coordinator|supervisor|developer)\b/i

interface Evidence {
  score: number
  notes: string[]
}

/** Weigh one occurrence of the value inside its clause. */
function weighOccurrence(clause: string, value: string): Evidence {
  const notes: string[] = []
  let score = 0

  const lowerClause = clause.toLowerCase()
  const idx = lowerClause.indexOf(value.toLowerCase())
  const after = idx >= 0 ? clause.slice(idx + value.length) : ''
  const nextWord = after.match(/^[\s,)]*([A-Za-z']+)/)?.[1]?.toLowerCase() ?? ''

  // A person acts. Anywhere in the clause counts, not only immediately after.
  const clauseWords = lowerClause.match(/[a-z']+/g) ?? []
  if (clauseWords.some((w) => PERSON_VERBS.has(w))) {
    score += 0.3
    notes.push('the sentence describes someone doing something')
  }

  if (PRONOUNS.test(clause)) {
    score += 0.2
    notes.push('a personal pronoun appears in the same sentence')
  }

  if (PERSON_ROLE.test(clause)) {
    score += 0.2
    notes.push('a job role is mentioned nearby')
  }

  // Directly modifying a noun is the classic adjectival giveaway.
  if (COMMON_NOUN_FOLLOWERS.has(nextWord)) {
    score -= 0.35
    notes.push(`it modifies the word "${nextWord}"`)
  } else if (FUNCTION_FOLLOWERS.has(nextWord)) {
    score -= 0.25
    notes.push(`it is followed by "${nextWord}"`)
  }

  return { score, notes }
}

async function confirm(
  requests: ConfirmationRequest[],
): Promise<ConfirmationVerdict[]> {
  return requests.map((request) => {
    // Every occurrence in the window gets a vote.
    const haystack = request.window.toLowerCase()
    const needle = request.value.toLowerCase()
    const occurrences: number[] = []
    let cursor = haystack.indexOf(needle)
    while (cursor !== -1 && occurrences.length < 12) {
      occurrences.push(cursor)
      cursor = haystack.indexOf(needle, cursor + needle.length)
    }
    if (!occurrences.length) occurrences.push(request.offset)

    let total = 0
    const notes = new Set<string>()

    for (const position of occurrences) {
      const evidence = weighOccurrence(
        clauseAround(request.window, position),
        request.value,
      )
      total += evidence.score
      evidence.notes.forEach((n) => notes.add(n))
    }

    const average = total / occurrences.length

    // Used in lower case somewhere? Then it is an ordinary word that happens
    // to be capitalised here.
    const usedLowercase = new RegExp(
      `(?<![A-Za-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`,
    ).test(request.window.replace(new RegExp(request.value, 'g'), ''))

    let score = average
    if (usedLowercase) {
      score -= 0.3
      notes.add('the same word is used in lower case nearby')
    }
    if (AMBIGUOUS_GIVEN_NAMES.has(needle)) {
      score -= 0.1
    }

    const note = notes.size ? `Looked more closely: ${[...notes].join('; ')}.` : undefined

    if (score >= 0.2) {
      return { id: request.id, decision: 'confirm', confidence: Math.min(1, 0.6 + score), note }
    }
    if (score <= -0.2) {
      return { id: request.id, decision: 'reject', confidence: Math.min(1, 0.6 - score), note }
    }
    return { id: request.id, decision: 'unknown', confidence: 0.5, note }
  })
}

export const deepContextConfirmer: LocalModelDetector = {
  id: 'deep-context',
  label: 'Deep context check',
  cost: { bytes: 0, startupMs: 0, perCandidateMs: null },
  isAvailable: async () => true,
  load: async () => {},
  confirm,
  get loaded() {
    return true
  },
}
