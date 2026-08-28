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

function cleanedName(name: string, forceExtension?: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot === -1 ? name : name.slice(0, dot)
  const ext = forceExtension ?? (dot === -1 ? '' : name.slice(dot))
  return `${base}-cleaned${ext}`
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

/**
 * Replace text inside one paragraph.
 *
 * Word splits a sentence across several <w:t> runs, so a value can straddle
 * two nodes. We try a per-node replacement first (which preserves bold/italic
 * runs exactly); if a value still survives, we fall back to writing the whole
 * cleaned paragraph into the first run so nothing sensitive can slip through.
 */
function rewriteParagraph(
  paragraph: string,
  entries: [string, string][],
): string {
  const nodes = [...paragraph.matchAll(TEXT_NODE_RE)]
  if (!nodes.length) return paragraph

  const plain = nodes.map((n) => unescapeXml(n[2])).join('')
  const hit = entries.filter(([from]) => plain.includes(from))
  if (!hit.length) return paragraph

  // Pass 1 — node by node, formatting preserved.
  let result = paragraph.replace(
    TEXT_NODE_RE,
    (_m, open: string, body: string, close: string) =>
      `${open}${escapeXml(applyMap(unescapeXml(body), hit))}${close}`,
  )

  const after = [...result.matchAll(TEXT_NODE_RE)]
    .map((n) => unescapeXml(n[2]))
    .join('')

  if (!hit.some(([from]) => after.includes(from))) return result

  // Pass 2 — value straddled runs: collapse the paragraph's text.
  const cleaned = applyMap(plain, hit)
  let first = true
  result = paragraph.replace(
    TEXT_NODE_RE,
    (_m, open: string, _body: string, close: string) => {
      if (first) {
        first = false
        const tag = open.includes('xml:space')
          ? open
          : open.replace(/>$/, ' xml:space="preserve">')
        return `${tag}${escapeXml(cleaned)}${close}`
      }
      return `${open}${close}`
    },
  )

  return result
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
        h?: string
        r?: string
        f?: string
      }
      if (cell.v == null) continue

      const original = String(cell.v)
      const replaced = applyMap(original, entries)
      if (replaced === original) continue

      cell.t = 's'
      cell.v = replaced
      cell.w = replaced
      delete cell.h
      delete cell.r
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
