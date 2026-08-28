/**
 * Document extraction.
 *
 * Every parser here runs in the browser tab. Nothing is uploaded, nothing is
 * written to disk, and the file bytes are held in memory only for as long as
 * the tab needs them to write a cleaned copy back out.
 */

import { PARAGRAPH_RE, TEXT_PARTS_RE, paragraphText } from './wordXml'

export type FileKind = 'txt' | 'csv' | 'docx' | 'xlsx' | 'pdf'

export interface ExtractedFile {
  name: string
  size: number
  kind: FileKind
  /** Plain text handed to the detection engine. */
  text: string
  /** Original bytes, kept in memory so we can write a cleaned copy. */
  buffer: ArrayBuffer
  /** e.g. "3 sheets · 240 rows" — shown on the file chip. */
  detail: string
  /** Worksheet names, which the document assessment treats as metadata. */
  sheetNames?: string[]
  /**
   * Set when the text was flattened from separate values (spreadsheet cells),
   * so the scanner can refuse findings that straddle two of them.
   */
  structuralDelimiter?: string
}

/** How spreadsheet cells are joined when flattened into scannable text. */
export const CELL_DELIMITER = ' | '

export const ACCEPTED_EXTENSIONS = [
  '.txt',
  '.md',
  '.log',
  '.json',
  '.csv',
  '.tsv',
  '.docx',
  '.xlsx',
  '.xlsm',
  '.pdf',
]

export class UnsupportedFileError extends Error {}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i).toLowerCase()
}

export function kindOf(name: string): FileKind | null {
  switch (extensionOf(name)) {
    case '.txt':
    case '.md':
    case '.log':
    case '.json':
      return 'txt'
    case '.csv':
    case '.tsv':
      return 'csv'
    case '.docx':
      return 'docx'
    case '.xlsx':
    case '.xlsm':
      return 'xlsx'
    case '.pdf':
      return 'pdf'
    default:
      return null
  }
}

const decoder = new TextDecoder()

async function extractSpreadsheet(
  buffer: ArrayBuffer,
): Promise<{ text: string; detail: string; sheetNames: string[] }> {
  const XLSX = await import('xlsx')
  const book = XLSX.read(buffer, { type: 'array', cellDates: true })

  const chunks: string[] = []
  let rowCount = 0

  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
      defval: '',
    })
    if (!rows.length) continue

    chunks.push(`--- ${sheetName} ---`)
    for (const row of rows) {
      const line = row
        .map((cell) => (cell == null ? '' : String(cell)))
        .join(CELL_DELIMITER)
        .replace(/(\s\|\s)+$/, '')
      if (line.trim()) chunks.push(line)
      rowCount += 1
    }
    chunks.push('')
  }

  const sheets = book.SheetNames.length
  return {
    text: chunks.join('\n').trim(),
    detail: `${sheets} sheet${sheets === 1 ? '' : 's'} · ${rowCount} rows`,
    sheetNames: [...book.SheetNames],
  }
}

async function extractDocx(
  buffer: ArrayBuffer,
): Promise<{ text: string; detail: string }> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buffer)
  const main = zip.file('word/document.xml')
  if (!main) {
    throw new UnsupportedFileError(
      'That Word file could not be opened. It may be an older .doc — save it as .docx and try again.',
    )
  }

  // Scan every part that can hold visible text, not just the body. Headers and
  // footers routinely carry the customer name and a classification marker, and
  // the exporter rewrites them — so they have to be scanned too, or there
  // would be no finding to apply.
  const partNames = Object.keys(zip.files)
    .filter((name) => TEXT_PARTS_RE.test(name))
    .sort((a, b) => {
      const rank = (n: string) =>
        n.startsWith('word/document') ? 0 : n.includes('header') ? 1 : 2
      return rank(a) - rank(b) || a.localeCompare(b)
    })

  const sections: string[] = []
  for (const name of partNames) {
    const xml = await zip.file(name)!.async('string')
    const section = (xml.match(PARAGRAPH_RE) ?? []).map(paragraphText).join('\n')
    if (section.trim()) sections.push(section)
  }

  const text = sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  const words = text.split(/\s+/).filter(Boolean).length
  return { text, detail: `${words.toLocaleString()} words` }
}

async function extractPdf(
  buffer: ArrayBuffer,
  onProgress?: (fraction: number) => void,
): Promise<{ text: string; detail: string }> {
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url'))
    .default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
  const pages: string[] = []

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const line = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s{2,}/g, ' ')
    pages.push(line.trim())
    onProgress?.(i / doc.numPages)
  }

  return {
    text: pages.join('\n\n').trim(),
    detail: `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`,
  }
}

export async function extractFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<ExtractedFile> {
  const kind = kindOf(file.name)
  if (!kind) {
    throw new UnsupportedFileError(
      `${extensionOf(file.name) || 'That file type'} is not supported yet. Try a .txt, .csv, .docx, .xlsx or .pdf file.`,
    )
  }

  const buffer = await file.arrayBuffer()
  onProgress?.(0.3)

  let extracted: { text: string; detail: string; sheetNames?: string[] }

  switch (kind) {
    case 'txt':
    case 'csv': {
      const text = decoder.decode(buffer)
      const lines = text.split('\n').length
      extracted = { text, detail: `${lines.toLocaleString()} lines` }
      break
    }
    case 'xlsx':
      extracted = await extractSpreadsheet(buffer)
      break
    case 'docx':
      extracted = await extractDocx(buffer)
      break
    case 'pdf':
      extracted = await extractPdf(buffer, (f) => onProgress?.(0.3 + f * 0.6))
      break
  }

  onProgress?.(1)

  return {
    name: file.name,
    size: file.size,
    kind,
    text: extracted.text,
    buffer,
    detail: extracted.detail,
    sheetNames: extracted.sheetNames,
    structuralDelimiter: kind === 'xlsx' ? CELL_DELIMITER : undefined,
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
