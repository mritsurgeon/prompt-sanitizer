import type { Detector, Finding } from '../types'
import {
  ORG_SUFFIXES,
  hasInfraToken,
  isFirstName,
  isOrgSuffixWord,
  isPlace,
  isSentenceStarter,
  isSurname,
  isTechAcronym,
} from '../gazetteer'

/**
 * Layer 2 — lightweight local entity recognition.
 *
 * This is a compact gazetteer + context-cue recogniser rather than a neural
 * NER model. That is a deliberate trade: it is ~40 KB of word lists, runs in
 * under a millisecond, needs no download, no GPU and no network — which is
 * what "local-first" has to mean on a normal business laptop. The detectors
 * are pluggable (see `Detector`), so a GLiNER / spaCy backend can be dropped
 * in later without touching the rest of the app.
 */

type Raw = Omit<Finding, 'id' | 'enabled'>

interface Token {
  text: string
  start: number
  end: number
}

const TITLE_RE = /^(?:mr|mrs|ms|miss|dr|prof|sir|madam|mnr|mev|dhr)\.?$/i

/** Words that introduce a person or a company right after them. */
const PERSON_CUES = new Set([
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
  'to',
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

const ORG_CUES = new Set([
  'customer',
  'client',
  'account',
  'partner',
  'reseller',
  'vendor',
  'supplier',
  'company',
  'tenant',
  'organisation',
  'organization',
])

const STREET_RE =
  /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][A-Za-z'-]+\s+){0,3}(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Drive|Dr\.?|Lane|Ln\.?|Boulevard|Blvd\.?|Way|Close|Crescent|Court|Ct\.?|Place|Terrace|Park|Square)\b(?:,?\s*(?:Unit|Suite|Apt|Flat|Block)\s*\w+)?/g

/** Capitalised words, including O'Brien and Jean-Luc. */
const CAP_TOKEN_RE = /\b[A-Z][A-Za-z'’-]*\b/g

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const re = new RegExp(CAP_TOKEN_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let value = m[0]
    let end = m.index + value.length
    // "Smith's" -> "Smith"
    const possessive = value.match(/['’]s$/)
    if (possessive) {
      value = value.slice(0, -2)
      end -= 2
    }
    if (value.length < 2) continue
    tokens.push({ text: value, start: m.index, end })
  }
  return tokens
}

/** Group tokens that sit next to each other with a single space between. */
function sequences(text: string, tokens: Token[]): Token[][] {
  const groups: Token[][] = []
  let current: Token[] = []

  for (const token of tokens) {
    const previous = current[current.length - 1]
    const gap = previous ? text.slice(previous.end, token.start) : null
    if (previous && gap !== null && /^[ ]$/.test(gap)) {
      current.push(token)
    } else {
      if (current.length) groups.push(current)
      current = [token]
    }
  }
  if (current.length) groups.push(current)
  return groups
}

/**
 * The word immediately before `index`. Only spaces may sit between, so
 * "customer ACME" gives "customer" but "customer [COMPANY]. Her" gives
 * nothing for "Her" — punctuation ends the context.
 */
function precedingWord(text: string, index: number): string {
  const match = text
    .slice(Math.max(0, index - 60), index)
    .match(/([A-Za-z]+)[ \t]*$/)
  return match ? match[1].toLowerCase() : ''
}

function isAllCaps(token: string) {
  return /^[A-Z][A-Z0-9&.]{1,}$/.test(token)
}

function startsSentence(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd()
  return before.length === 0 || /[.!?:;\n]$/.test(before)
}

function orgSuffixAfter(text: string, end: number): string | null {
  const tail = text.slice(end, end + 24)
  for (const suffix of ORG_SUFFIXES) {
    const re = new RegExp(`^\\s+${suffix.replace(/[.()]/g, '\\$&')}(?![A-Za-z])`)
    const m = tail.match(re)
    if (m) return m[0]
  }
  return null
}

export function runEntityRules(text: string): Raw[] {
  const out: Raw[] = []
  const tokens = tokenize(text)
  const groups = sequences(text, tokens)

  for (const raw of groups) {
    // Skip anything that is clearly infrastructure or an acronym soup.
    if (raw.every((t) => isTechAcronym(t.text))) continue
    // "Her", "The", "Please" — capitalised, but never an entity.
    if (raw.every((t) => isSentenceStarter(t.text))) continue

    // At the start of a sentence the cue word is capitalised too, so it lands
    // inside the group: "Dear Mr Patel", "Contact Priya Naidoo". Peel those
    // off and treat them as context rather than as part of the name.
    let cue = precedingWord(text, raw[0].start)
    let titled = TITLE_RE.test(cue)
    let offset = 0

    while (offset < raw.length - 1) {
      const word = raw[offset].text
      const lower = word.toLowerCase()
      if (TITLE_RE.test(word)) {
        titled = true
      } else if (
        PERSON_CUES.has(lower) ||
        ORG_CUES.has(lower) ||
        isSentenceStarter(lower)
      ) {
        cue = lower
      } else {
        break
      }
      offset += 1
    }

    const group = raw.slice(offset)
    const first = group[0]
    const last = group[group.length - 1]

    // ---- company: "ACME Holdings", "Northwind Traders Ltd" -------------
    if (group.length >= 2 && isOrgSuffixWord(last.text)) {
      out.push({
        category: 'ORGANISATION',
        value: text.slice(first.start, last.end),
        start: first.start,
        end: last.end,
        confidence: 0.92,
        layer: 'entity',
        rule: `Company name ending in "${last.text}"`,
      })
      continue
    }

    // ---- company: "<Name> Pty Ltd" ------------------------------------
    const suffix = orgSuffixAfter(text, last.end)
    if (suffix && !isTechAcronym(first.text)) {
      out.push({
        category: 'ORGANISATION',
        value: text.slice(first.start, last.end + suffix.length),
        start: first.start,
        end: last.end + suffix.length,
        confidence: 0.95,
        layer: 'entity',
        rule: 'Company name with trading suffix',
      })
      continue
    }

    // ---- company: "customer ACME" / "client Northwind" -----------------
    if (ORG_CUES.has(cue)) {
      const value = text.slice(first.start, last.end)
      const looksPersonal = isFirstName(first.text)
      if (!looksPersonal && !isTechAcronym(value)) {
        out.push({
          category: 'ORGANISATION',
          value,
          start: first.start,
          end: last.end,
          confidence: isAllCaps(first.text) ? 0.88 : 0.78,
          layer: 'entity',
          rule: `Company name after "${cue}"`,
        })
        continue
      }
    }

    // ---- place: "Cape Town", "Johannesburg" ---------------------------
    const joined = group.map((t) => t.text).join('')
    if (isPlace(joined) || (group.length === 1 && isPlace(first.text))) {
      out.push({
        category: 'LOCATION',
        value: text.slice(first.start, last.end),
        start: first.start,
        end: last.end,
        confidence: 0.72,
        layer: 'entity',
        rule: 'Known city or country',
      })
      continue
    }

    // ---- people --------------------------------------------------------
    const names = group.filter((t) => !isTechAcronym(t.text))
    if (!names.length) continue

    const head = names[0]
    const tail = names[names.length - 1]
    const firstIsGiven = isFirstName(head.text)
    const lastIsFamily = isSurname(tail.text)
    const multi = names.length >= 2 && names.length <= 4

    let confidence = 0
    let rule = ''

    if (titled && multi) {
      confidence = 0.96
      rule = 'Title followed by a full name'
    } else if (titled) {
      confidence = 0.9
      rule = 'Title followed by a name'
    } else if (multi && firstIsGiven && lastIsFamily) {
      confidence = 0.96
      rule = 'Known given name and surname'
    } else if (multi && firstIsGiven) {
      confidence = 0.9
      rule = 'Known given name followed by a capitalised surname'
    } else if (multi && lastIsFamily && PERSON_CUES.has(cue)) {
      confidence = 0.82
      rule = `Known surname after "${cue}"`
    } else if (!multi && firstIsGiven && PERSON_CUES.has(cue)) {
      confidence = 0.85
      rule = `Given name after "${cue}"`
    } else if (
      !multi &&
      firstIsGiven &&
      !isSentenceStarter(head.text) &&
      !startsSentence(text, head.start)
    ) {
      confidence = 0.7
      rule = 'Known given name'
    }

    if (!confidence) continue
    if (hasInfraToken(text.slice(head.start, tail.end))) continue

    out.push({
      category: 'PERSON',
      value: text.slice(head.start, tail.end),
      start: head.start,
      end: tail.end,
      confidence,
      layer: 'entity',
      rule,
    })
  }

  // ---- street addresses ------------------------------------------------
  const streetRe = new RegExp(STREET_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = streetRe.exec(text)) !== null) {
    out.push({
      category: 'POSTAL_ADDRESS',
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
      confidence: 0.85,
      layer: 'entity',
      rule: 'Street address',
    })
  }

  return out
}

export const entityDetector: Detector = {
  id: 'entities',
  layer: 'entity',
  run: runEntityRules,
}
