/**
 * Ingestion normalisation, with a way back.
 *
 * Layer 1 is regexes over exact characters, so anything that changes the
 * characters without changing what a human reads defeats it silently. Most of
 * that is not an attack — it is ordinary text:
 *
 *  - a phone number with a non-breaking space in it, pasted out of a web page;
 *  - soft hyphens left behind by PDF extraction, inside a word;
 *  - full-width digits from a CJK keyboard;
 *  - curly quotes and en dashes from a word processor, inside a connection
 *    string.
 *
 * And some of it is: one Cyrillic `а` in `pаypal.com` is invisible and makes
 * the URL rule miss.
 *
 * ## What NFKC already does, and what it does not
 *
 * Measured rather than assumed, because the difference decides how big the
 * fold table has to be. NFKC **already** handles full-width digits and
 * letters, mathematical alphanumerics (`𝐀` → `A`), non-breaking and narrow
 * spaces, ligatures (`ﬁ` → `fi`), and combining-mark composition. A fold table
 * listing those — as the obvious first draft does — is dead weight.
 *
 * NFKC leaves alone, so this file must handle: zero-width and format
 * characters, soft hyphens, dashes, curly quotes, and every script-confusable
 * (Cyrillic, Greek).
 *
 * ## Why the mapping is the hard part
 *
 * Detection runs on the normalised text, but a finding has to point at the
 * original — the sanitizer rewrites the user's real document, the highlighter
 * draws on it, and the Word writer maps offsets into runs. Normalisation
 * changes lengths in both directions (`ﬁ` is one character that becomes two;
 * `é` can be two that become one; a zero-width space is one that becomes
 * none), so offsets do not survive it. Every normalised character therefore
 * records the range of original characters it came from.
 *
 * ## Correctness notes worth keeping
 *
 * Normalisation is **not** a per-character operation. NFKC composes across
 * combining sequences — `e` + U+0301 is two characters that normalise to one —
 * so a character-at-a-time loop, which is the natural way to write this, does
 * not implement NFKC. Iteration is by grapheme cluster.
 *
 * Expansion is also not bounded by any small constant, so the maps grow rather
 * than being sized by a guessed multiple of the input.
 */

/** Removed outright: invisible, and only ever used to break up a token. */
const STRIPPABLE = new Set([
  '​', // zero-width space
  '‌', // zero-width non-joiner
  '‍', // zero-width joiner
  '⁠', // word joiner
  '﻿', // zero-width no-break space / BOM
  '­', // soft hyphen — PDF extraction leaves these mid-word
  '᠎', // Mongolian vowel separator
  '͏', // combining grapheme joiner
])

/**
 * Folded to their ASCII lookalike.
 *
 * Only characters NFKC does not already handle. Deliberately conservative:
 * this runs over every document, and folding something that is not actually a
 * lookalike would corrupt real text.
 */
const CONFUSABLES: Record<string, string> = {
  // --- punctuation a word processor substitutes silently -------------------
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-', // en dash
  '—': '-', // em dash
  '―': '-',
  '−': '-', // minus sign
  '‘': "'",
  '’': "'", // curly apostrophe — breaks `password='...'`
  '‚': "'",
  '‛': "'",
  '′': "'",
  '´': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '″': '"',
  '⁄': '/', // fraction slash
  '∶': ':', // ratio
  '：': ':', // NFKC handles most full-width, but not inside all contexts

  // --- Cyrillic ------------------------------------------------------------
  'а': 'a',
  'е': 'e',
  'о': 'o',
  'с': 'c',
  'р': 'p',
  'х': 'x',
  'у': 'y',
  'і': 'i',
  'ј': 'j',
  'һ': 'h',
  'ѕ': 's',
  'ӏ': 'l',
  'А': 'A',
  'В': 'B',
  'С': 'C',
  'Е': 'E',
  'Н': 'H',
  'К': 'K',
  'М': 'M',
  'О': 'O',
  'Р': 'P',
  'Т': 'T',
  'Х': 'X',
  'Ѕ': 'S',
  'І': 'I',
  'Ј': 'J',

  // --- Greek ---------------------------------------------------------------
  'ο': 'o',
  'α': 'a',
  'ε': 'e',
  'ι': 'i',
  'ν': 'v',
  'ρ': 'p',
  'υ': 'u',
  'Α': 'A',
  'Β': 'B',
  'Ε': 'E',
  'Ζ': 'Z',
  'Η': 'H',
  'Ι': 'I',
  'Κ': 'K',
  'Μ': 'M',
  'Ν': 'N',
  'Ο': 'O',
  'Ρ': 'P',
  'Τ': 'T',
  'Υ': 'Y',
  'Χ': 'X',

  // --- Armenian and Cherokee lookalikes ------------------------------------
  'հ': 'h',
  'ս': 'u',
  'Ꭰ': 'D',
  'Ꭺ': 'W',
  'Ꮐ': 'G',
}

export interface Normalised {
  /** What the detectors run on. */
  text: string
  /** True when normalisation actually changed anything. */
  changed: boolean
  /**
   * Map a range in normalised coordinates back to the original.
   *
   * Total, so a caller never has to reason about it: an out-of-range or
   * inverted input clamps rather than throwing, because a detector producing
   * one is a bug that must not become a crash in somebody's document.
   */
  project(start: number, end: number): [number, number]
}

/** Identity, for text that needed nothing. */
function unchanged(text: string): Normalised {
  return {
    text,
    changed: false,
    project: (start, end) => [
      Math.max(0, Math.min(text.length, start)),
      Math.max(0, Math.min(text.length, end)),
    ],
  }
}

/**
 * ASCII text cannot need any of this — every strippable character, every
 * confusable and everything NFKC touches is outside ASCII. Checked with a
 * charCode scan rather than a regex over a 700 KB string, and it is the
 * common case, so the whole expensive path is skipped for most documents.
 */
function isPlainAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false
  }
  return true
}

type Segmenter = { segment(input: string): Iterable<{ segment: string; index: number }> }

const segmenter: Segmenter | null = (() => {
  try {
    // Grapheme clusters, because NFKC composes across combining marks and a
    // per-character loop therefore does not implement it.
    return new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  } catch {
    return null
  }
})()

/** Code points, when `Intl.Segmenter` is unavailable. Loses cluster
 *  composition; never crashes. */
function* codePoints(text: string): Iterable<{ segment: string; index: number }> {
  let index = 0
  for (const character of text) {
    yield { segment: character, index }
    index += character.length
  }
}

export function normalise(raw: string): Normalised {
  if (!raw || isPlainAscii(raw)) return unchanged(raw)

  let capacity = raw.length + 16
  let starts = new Int32Array(capacity)
  let ends = new Int32Array(capacity)
  let out = ''
  let length = 0
  let changed = false

  const grow = (needed: number) => {
    if (needed <= capacity) return
    while (capacity < needed) capacity *= 2
    const nextStarts = new Int32Array(capacity)
    const nextEnds = new Int32Array(capacity)
    nextStarts.set(starts.subarray(0, length))
    nextEnds.set(ends.subarray(0, length))
    starts = nextStarts
    ends = nextEnds
  }

  const clusters = segmenter ? segmenter.segment(raw) : codePoints(raw)

  for (const { segment, index } of clusters) {
    const from = index
    const to = index + segment.length

    // Fast path: plain ASCII needs no allocation, no NFKC and no lookup.
    if (segment.length === 1 && segment.charCodeAt(0) <= 0x7f) {
      grow(length + 1)
      out += segment
      starts[length] = from
      ends[length] = to
      length += 1
      continue
    }

    let mapped = segment.normalize('NFKC')
    if (mapped !== segment) changed = true

    // Folded after NFKC, so the table never has to duplicate it.
    let folded = ''
    for (const character of mapped) {
      if (STRIPPABLE.has(character)) {
        changed = true
        continue
      }
      const substitute = CONFUSABLES[character]
      if (substitute !== undefined) {
        changed = true
        folded += substitute
      } else {
        folded += character
      }
    }
    mapped = folded

    grow(length + mapped.length)
    out += mapped
    for (let i = 0; i < mapped.length; i++) {
      // Every character produced by this cluster points at the whole cluster.
      // A match starting mid-cluster therefore projects to the cluster's
      // start, which is what a caller wants: the original characters that
      // produced it, not a position inside a composed sequence.
      starts[length] = from
      ends[length] = to
      length += 1
    }
  }

  if (!changed) return unchanged(raw)

  const startMap = starts.subarray(0, length)
  const endMap = ends.subarray(0, length)

  return {
    text: out,
    changed: true,
    project(start, end) {
      if (length === 0) return [0, 0]
      const s = Math.max(0, Math.min(length, start))
      const e = Math.max(s, Math.min(length, end))
      const rawStart = s >= length ? raw.length : startMap[s]
      const rawEnd = e <= s ? rawStart : endMap[e - 1]
      return [rawStart, Math.max(rawStart, rawEnd)]
    },
  }
}
