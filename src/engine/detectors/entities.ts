import type { Candidate, Detector } from '../types'
import {
  ORG_SUFFIXES,
  hasInfraToken,
  isFirstName,
  isCountry,
  isInstitutionPhrase,
  isJobTitlePhrase,
  isOrgSuffixWord,
  isPlace,
  isSentenceStarter,
  isSurname,
  isTechAcronym,
  startsWithGenericModifier,
} from '../gazetteer'
import { ORG_OWNERSHIP_RE } from '../lexicon'

/**
 * Layer 2a — candidate generation for people, companies and places.
 *
 * This file deliberately does NOT decide anything. It proposes candidates with
 * a `base` score reflecting only what the gazetteers know, and flags whether
 * the surface form is ambiguous or unrecognised. All context weighing happens
 * in `context.ts`, which keeps the two concerns separable and testable.
 *
 * It is a compact gazetteer + shape recogniser rather than a neural NER model:
 * a few tens of kilobytes of word lists, well under a millisecond, no
 * download, no GPU, no network.
 */

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

/**
 * Capitalised words, including O'Brien, Jean-Luc and Mornè.
 *
 * Unicode-aware on purpose. An `[A-Z][A-Za-z]*` pattern splits "Mornè" into
 * "Morn" + "è", which breaks the name in half and loses it entirely — and the
 * names it loses are disproportionately the non-English ones.
 */
const CAP_TOKEN_RE = /\p{Lu}[\p{L}'’-]*/gu

// Base scores. These reflect gazetteer support only — context does the rest.
const BASE = {
  titledFull: 0.9,
  titledSingle: 0.85,
  givenAndSurname: 0.96,
  givenAndCapitalised: 0.85,
  givenAlone: 0.7,
  /**
   * Two or more capitalised words no gazetteer recognises.
   *
   * Deliberately below the medium threshold: on shape alone this is a guess,
   * and in a document full of Title Case headings and skills the guess is
   * usually wrong. It needs either real context (a cue, a person verb, a
   * heading position) or the confirmer to become a finding.
   */
  unresolvedPhrase: 0.45,
  /** A single capitalised word no gazetteer recognises. */
  unresolvedToken: 0.3,
  orgSuffix: 0.92,
  orgTradingSuffix: 0.95,
  orgOwnership: 0.85,
  orgAllCapsAfterCue: 0.88,
  orgAfterCue: 0.78,
  place: 0.72,
  street: 0.85,
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const re = new RegExp(CAP_TOKEN_RE.source, 'gu')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let value = m[0]
    let end = m.index + value.length
    // Strip contractions, not just possessives: "Smith's" -> "Smith", and
    // "I'd" -> "I", which is then too short to be a candidate at all. Without
    // this, every "I'd", "I'm" and "I'll" in a document looks like a name.
    const contraction = value.match(/['’](?:s|d|m|re|ve|ll|t)$/i)
    if (contraction) {
      value = value.slice(0, -contraction[0].length)
      end -= contraction[0].length
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

function precedingWord(text: string, index: number): string {
  const match = text
    .slice(Math.max(0, index - 60), index)
    .match(/([A-Za-z]+)[ \t]*$/)
  return match ? match[1].toLowerCase() : ''
}

function isAllCaps(token: string) {
  return /^[A-Z][A-Z0-9&.]{1,}$/.test(token)
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

export function runEntityRules(text: string): Candidate[] {
  const out: Candidate[] = []
  const groups = sequences(text, tokenize(text))

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
    const value = text.slice(first.start, last.end)
    const single = group.length === 1

    // ---- company: "ACME Holdings", "Northwind Traders Ltd" -------------
    if (
      group.length >= 2 &&
      isOrgSuffixWord(last.text) &&
      !startsWithGenericModifier(value)
    ) {
      out.push({
        category: 'ORGANISATION',
        value,
        start: first.start,
        end: last.end,
        base: BASE.orgSuffix,
        layer: 'entity',
        rule: `Company name ending in "${last.text}"`,
        singleToken: false,
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
        base: BASE.orgTradingSuffix,
        layer: 'entity',
        rule: 'Company name with trading suffix',
        singleToken: false,
      })
      continue
    }

    // ---- company: "Amazon is our customer" -----------------------------
    // Ownership context after the name, which is how a customer usually gets
    // named in an internal note.
    if (ORG_OWNERSHIP_RE.test(text.slice(last.end)) && !isTechAcronym(value)) {
      out.push({
        category: 'ORGANISATION',
        value,
        start: first.start,
        end: last.end,
        base: BASE.orgOwnership,
        layer: 'entity',
        rule: 'Named as a customer, client or partner',
        singleToken: single,
      })
      continue
    }

    // ---- company: "customer ACME" / "client Northwind" -----------------
    if (ORG_CUES.has(cue)) {
      const looksPersonal = isFirstName(first.text)
      // "Customer Relationship Management" is a skill, not a company that
      // happens to follow the word "customer".
      const looksLikeRole =
        isJobTitlePhrase(value) || isInstitutionPhrase(value)
      if (!looksPersonal && !looksLikeRole && !isTechAcronym(value)) {
        out.push({
          category: 'ORGANISATION',
          value,
          start: first.start,
          end: last.end,
          base: isAllCaps(first.text) ? BASE.orgAllCapsAfterCue : BASE.orgAfterCue,
          layer: 'entity',
          rule: `Company name after "${cue}"`,
          singleToken: single,
        })
        continue
      }
    }

    // ---- countries are not sensitive ----------------------------------
    // Mentioning a country identifies nobody. Ruled out explicitly so it is
    // not mistaken for an unrecognised name further down.
    const joinedRaw = group.map((t) => t.text).join('')
    if (isCountry(joinedRaw) || (single && isCountry(first.text))) continue

    // ---- place: "Cape Town", "Johannesburg" ---------------------------
    const joined = joinedRaw
    if (isPlace(joined) || (single && isPlace(first.text))) {
      out.push({
        category: 'LOCATION',
        value,
        start: first.start,
        end: last.end,
        base: BASE.place,
        layer: 'entity',
        rule: 'Known city or country',
        singleToken: single,
      })
      continue
    }

    // ---- people --------------------------------------------------------
    let names = group.filter((t) => !isTechAcronym(t.text))
    if (!names.length) continue

    // A capitalised word can sit in front of a name without being part of it:
    // "Later Sarah Mitchell emailed again". Trim leading tokens no gazetteer
    // recognises when the next one is a known given name, so the same person
    // yields the same value — and therefore the same stand-in — everywhere.
    let nameStart = 0
    while (
      nameStart < names.length - 1 &&
      !isFirstName(names[nameStart].text) &&
      !isSurname(names[nameStart].text) &&
      isFirstName(names[nameStart + 1].text)
    ) {
      nameStart += 1
    }
    if (nameStart > 0) names = names.slice(nameStart)
    if (hasInfraToken(text.slice(names[0].start, names[names.length - 1].end))) {
      continue
    }

    const head = names[0]
    const tail = names[names.length - 1]
    const nameValue = text.slice(head.start, tail.end)
    const firstIsGiven = isFirstName(head.text)
    const lastIsFamily = isSurname(tail.text)
    const multi = names.length >= 2 && names.length <= 4
    const singleName = names.length === 1

    let base = 0
    let rule = ''
    let unresolved = false

    if (titled && multi) {
      base = BASE.titledFull
      rule = 'Title followed by a full name'
    } else if (titled) {
      base = BASE.titledSingle
      rule = 'Title followed by a name'
    } else if (multi && firstIsGiven && lastIsFamily) {
      base = BASE.givenAndSurname
      rule = 'Known given name and surname'
    } else if (multi && firstIsGiven) {
      base = BASE.givenAndCapitalised
      rule = 'Known given name followed by a capitalised surname'
    } else if (multi && lastIsFamily) {
      base = BASE.givenAndCapitalised
      rule = 'Capitalised word followed by a known surname'
    } else if (singleName && firstIsGiven) {
      base = BASE.givenAlone
      rule = 'Known given name'
    } else if (multi) {
      // Two or more capitalised words that no list recognises. Could be a name
      // we have never seen, could be a product. Context decides — and this is
      // the recall path that a gazetteer alone would miss entirely.
      base = BASE.unresolvedPhrase
      rule = 'Capitalised words that may be a name'
      unresolved = true
    } else {
      base = BASE.unresolvedToken
      rule = 'Capitalised word that may be a name'
      unresolved = true
    }

    // A role or a place of study is not a person. These are the commonest
    // mislabels in a CV, and no amount of surrounding context fixes them
    // because the phrase really does sit where a name would sit.
    if (unresolved && (isJobTitlePhrase(nameValue) || isInstitutionPhrase(nameValue))) {
      continue
    }

    // "Cisco CCNP", "Brocade BCFP" — a phrase ending in a short all-caps
    // acronym is a certification or a product code. A person's surname is not
    // an acronym, so this does not catch "IAN ENGELBRECHT", where the long
    // trailing token is plainly a name.
    const acronymish = (t: string) => /^[A-Z0-9]{2,6}$/.test(t)
    if (
      unresolved &&
      names.length >= 2 &&
      acronymish(tail.text) &&
      !acronymish(head.text)
    ) {
      continue
    }

    out.push({
      category: 'PERSON',
      value: nameValue,
      start: head.start,
      end: tail.end,
      base,
      layer: 'entity',
      rule,
      singleToken: singleName,
      unresolved,
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
      base: BASE.street,
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
