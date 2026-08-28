import type { ExtractedFile } from './extract'
import {
  PARAGRAPH_RE,
  TEXT_NODE_RE,
  TEXT_PARTS_RE,
  escapeXml,
  unescapeXml,
} from './wordXml'

/**
 * Writes a cleaned copy of an uploaded file.
 *
 * The original file is never modified — we build a new document in memory and
 * hand it to the browser's download. Spreadsheets keep their sheets, rows and
 * cell types; Word documents keep their paragraph and (where possible) run
 * formatting, with only the sensitive text swapped out.
 */

export interface CleanedFile {
  blob: Blob
  filename: string
}

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** "EMEA PAC — VIP session.xlsx" -> "EMEA PAC — VIP session — sanitized.xlsx" */
function cleanedName(name: string, forceExtension?: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot === -1 ? name : name.slice(0, dot)
  const ext = forceExtension ?? (dot === -1 ? '' : name.slice(dot))
  return `${base} — sanitized${ext}`
}

/** Longest-first so `CUST-1234` is replaced before a shorter overlapping key. */
function orderedEntries(valueMap: Map<string, string>): [string, string][] {
  return [...valueMap.entries()]
    .filter(([from]) => from.length > 0)
    .sort((a, b) => b[0].length - a[0].length)
}

function applyMap(text: string, entries: [string, string][]): string {
  let out = text
  for (const [from, to] of entries) {
    if (!out.includes(from)) continue
    out = out.split(from).join(to)
  }
  return out
}

// --------------------------------------------------------------------------
// Word
// --------------------------------------------------------------------------

interface Range {
  start: number
  end: number
  to: string
}

/**
 * Replace text inside one paragraph, run by run.
 *
 * Word freely splits a sentence across several <w:t> runs — a spell-check
 * boundary is enough to do it — so "John Smith" is regularly stored as
 * "John Sm" + "ith". Replacing node-by-node therefore misses things, and
 * collapsing the whole paragraph into one run destroys the bold, italics and
 * colours in it.
 *
 * So this works on the paragraph's concatenated plain text, maps each
 * replacement back to character ranges, and rebuilds each run: text outside a
 * range passes through untouched with its own formatting, the replacement is
 * emitted in the run where the match began (inheriting that run's formatting),
 * and the remaining covered characters are dropped. Every other run in the
 * paragraph is left exactly as it was.
 */
function rewriteParagraph(
  paragraph: string,
  entries: [string, string][],
): string {
  const nodes = [...paragraph.matchAll(TEXT_NODE_RE)]
  if (!nodes.length) return paragraph

  const bodies = nodes.map((n) => unescapeXml(n[2]))
  const plain = bodies.join('')

  // Map every occurrence to a character range over the joined text.
  const ranges: Range[] = []
  for (const [from, to] of entries) {
    if (!from || !plain.includes(from)) continue
    let at = plain.indexOf(from)
    while (at !== -1) {
      const end = at + from.length
      const clashes = ranges.some((r) => at < r.end && r.start < end)
      if (!clashes) ranges.push({ start: at, end, to })
      at = plain.indexOf(from, end)
    }
  }
  if (!ranges.length) return paragraph

  ranges.sort((a, b) => a.start - b.start)

  const rewritten: string[] = []
  let cursor = 0

  for (const body of bodies) {
    const from = cursor
    const to = cursor + body.length
    cursor = to

    let out = ''
    for (let i = from; i < to; i++) {
      const range = ranges.find((r) => i >= r.start && i < r.end)
      if (!range) {
        out += plain[i]
      } else if (i === range.start) {
        out += range.to
      }
      // Characters inside a range but not at its start are dropped — the
      // replacement has already been emitted in the run where it started.
    }
    rewritten.push(out)
  }

  let index = 0
  return paragraph.replace(
    TEXT_NODE_RE,
    (_m, open: string, _body: string, close: string) => {
      const body = rewritten[index++] ?? ''
      // Preserve significant whitespace, which a rebuilt run can easily lose.
      const tag = open.includes('xml:space')
        ? open
        : open.replace(/>$/, ' xml:space="preserve">')
      return `${tag}${escapeXml(body)}${close}`
    },
  )
}

async function rewriteDocx(
  buffer: ArrayBuffer,
  valueMap: Map<string, string>,
): Promise<Blob> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buffer)
  const entries = orderedEntries(valueMap)

  const targets = Object.keys(zip.files).filter((name) =>
    TEXT_PARTS_RE.test(name),
  )

  for (const name of targets) {
    const file = zip.file(name)
    if (!file) continue
    const xml = await file.async('string')
    zip.file(
      name,
      xml.replace(PARAGRAPH_RE, (p) => rewriteParagraph(p, entries)),
    )
  }

  return zip.generateAsync({ type: 'blob', mimeType: DOCX_MIME })
}

// --------------------------------------------------------------------------
// Excel
// --------------------------------------------------------------------------

async function rewriteWorkbook(
  buffer: ArrayBuffer,
  valueMap: Map<string, string>,
): Promise<Blob> {
  const XLSX = await import('xlsx')
  const entries = orderedEntries(valueMap)
  const book = XLSX.read(buffer, { type: 'array', cellStyles: true })

  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName]
    if (!sheet) continue

    for (const ref of Object.keys(sheet)) {
      if (ref.startsWith('!')) continue
      const cell = sheet[ref] as {
        t?: string
        v?: unknown
        w?: string
        z?: string
        h?: string
        r?: string
        f?: string
      }
      if (cell.v == null) continue

      // The scanner reads formatted values (so a date reads as "2026-03-31"),
      // which is what the user saw and what the finding matched. So try the
      // formatted text first, then fall back to the raw value.
      const formatted = cell.w ?? String(cell.v)
      const raw = String(cell.v)
      const replaced = applyMap(formatted, entries)
      const replacedRaw = applyMap(raw, entries)

      if (replaced === formatted && replacedRaw === raw) continue

      const value = replaced !== formatted ? replaced : replacedRaw
      const wasNumeric = cell.t === 'n' || cell.t === 'd'

      cell.t = 's'
      cell.v = value
      cell.w = value
      // A number format on a now-textual cell renders as nonsense.
      if (wasNumeric) delete cell.z
      delete cell.h
      delete cell.r
      // Drop the formula: it would recompute and reintroduce the value.
      delete cell.f
    }
  }

  const out = XLSX.write(book, {
    bookType: 'xlsx',
    type: 'array',
    cellStyles: true,
  }) as ArrayBuffer

  return new Blob([out], { type: XLSX_MIME })
}

// --------------------------------------------------------------------------

export async function buildCleanedFile(
  source: ExtractedFile,
  sanitizedText: string,
  valueMap: Map<string, string>,
): Promise<CleanedFile> {
  switch (source.kind) {
    case 'xlsx':
      return {
        blob: await rewriteWorkbook(source.buffer, valueMap),
        filename: cleanedName(source.name),
      }
    case 'docx':
      return {
        blob: await rewriteDocx(source.buffer, valueMap),
        filename: cleanedName(source.name),
      }
    case 'pdf':
      // We can read a PDF's text but not safely rewrite its layout, so the
      // cleaned copy is delivered as text rather than a broken PDF.
      return {
        blob: new Blob([sanitizedText], { type: 'text/plain;charset=utf-8' }),
        filename: cleanedName(source.name, '.txt'),
      }
    default:
      return {
        blob: new Blob([sanitizedText], {
          type: source.kind === 'csv' ? 'text/csv' : 'text/plain;charset=utf-8',
        }),
        filename: cleanedName(source.name),
      }
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Give the browser a beat to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
