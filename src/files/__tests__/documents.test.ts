import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { scan } from '@/engine/detect'
import { sanitize } from '@/engine/sanitize'
import { buildCleanedFile } from '../exportFile'
import { extractFile } from '../extract'
import {
  DOCX_FIXTURE_FACTS as DOCX,
  XLSX_FIXTURE_FACTS as XLS,
  buildRichDocx,
  buildRichXlsx,
} from './buildFixtures'

/**
 * End-to-end document tests: extract -> scan -> sanitize -> write a clean copy
 * -> re-open the clean copy. Two things must hold every time: the sensitive
 * content is gone, and the document is still a document.
 */

async function cleanRoundTrip(name: string, buffer: ArrayBuffer) {
  const source = await extractFile(new File([buffer], name))
  const before = scan(source.text, {
    meta: { filename: name, sheetNames: source.sheetNames },
    structuralDelimiter: source.structuralDelimiter,
  })
  const cleaned = sanitize(source.text, before.findings, { mode: 'redact' })
  const output = await buildCleanedFile(source, cleaned.text, cleaned.valueMap)
  const reopened = await extractFile(
    new File([await output.blob.arrayBuffer()], output.filename),
  )
  return { source, before, cleaned, output, reopened }
}

describe('docx sanitization', () => {
  it('replaces a name that is split across two Word runs', async () => {
    const { source, reopened } = await cleanRoundTrip(
      'incident review.docx',
      await buildRichDocx(),
    )

    // The fixture stores "John Sm" + "ith" in separate runs.
    expect(source.text).toContain(DOCX.splitName)
    expect(reopened.text).not.toContain(DOCX.splitName)
    expect(reopened.text).not.toContain('John Sm')
    expect(reopened.text).toContain('[PERSON_NAME]')
  })

  it('scans and cleans headers and footers, not just the body', async () => {
    const { source, reopened } = await cleanRoundTrip(
      'incident review.docx',
      await buildRichDocx(),
    )

    // Header and footer content must be visible to the scanner...
    expect(source.text).toContain(DOCX.headerCompany)
    expect(source.text).toContain(DOCX.footerEmail)

    // ...and gone from the cleaned copy.
    expect(reopened.text).not.toContain(DOCX.footerEmail)
    expect(reopened.text).not.toContain(DOCX.footerName)
  })

  it('removes every finding in a paragraph that has several', async () => {
    const { reopened } = await cleanRoundTrip(
      'incident review.docx',
      await buildRichDocx(),
    )

    for (const value of [DOCX.email, DOCX.phone, DOCX.caseId, DOCX.customerId]) {
      expect(reopened.text).not.toContain(value)
    }
  })

  it('cleans table cells and keeps the table', async () => {
    const buffer = await buildRichDocx()
    const { output, reopened } = await cleanRoundTrip('incident review.docx', buffer)

    expect(reopened.text).not.toContain(DOCX.tableName)
    expect(reopened.text).not.toContain(DOCX.tableEmail)

    const zip = await JSZip.loadAsync(await output.blob.arrayBuffer())
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('<w:tc>')
  })

  it('preserves formatting, styles and document parts', async () => {
    const { output } = await cleanRoundTrip(
      'incident review.docx',
      await buildRichDocx(),
    )
    const zip = await JSZip.loadAsync(await output.blob.arrayBuffer())
    const names = Object.keys(zip.files)

    // Every part survives the rewrite.
    for (const part of [
      'word/document.xml',
      'word/header1.xml',
      'word/footer1.xml',
      'word/styles.xml',
      'word/_rels/document.xml.rels',
      '[Content_Types].xml',
    ]) {
      expect(names).toContain(part)
    }

    const xml = await zip.file('word/document.xml')!.async('string')
    // Bold, italic, sizes, headings and section properties all still there.
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('<w:i/>')
    expect(xml).toContain('<w:sz w:val="32"/>')
    expect(xml).toContain('w:pStyle w:val="Heading1"')
    expect(xml).toContain('<w:sectPr>')

    // An untouched paragraph keeps its text exactly.
    expect(xml).toContain('unremarkable')
  })

  it('names the output file without touching the original', async () => {
    const buffer = await buildRichDocx()
    const originalBytes = buffer.byteLength
    const { output } = await cleanRoundTrip('incident review.docx', buffer)

    expect(output.filename).toBe('incident review — sanitized.docx')
    expect(buffer.byteLength).toBe(originalBytes)
  })
})

describe('xlsx sanitization', () => {
  it('replaces sensitive cell values across sheets', async () => {
    const { source, reopened } = await cleanRoundTrip(
      'customer contacts.xlsx',
      buildRichXlsx(),
    )

    expect(source.text).toContain(XLS.name)
    for (const value of [XLS.name, XLS.email, XLS.phone, XLS.customerId]) {
      expect(reopened.text).not.toContain(value)
    }
    expect(reopened.text).toContain('[EMAIL]')
  })

  it('keeps sheets, merged cells, column widths and row heights', async () => {
    const { output } = await cleanRoundTrip(
      'customer contacts.xlsx',
      buildRichXlsx(),
    )

    const XLSX = await import('xlsx')
    const book = XLSX.read(await output.blob.arrayBuffer(), {
      type: 'array',
      cellStyles: true,
    })

    expect(book.SheetNames).toEqual(['Contacts', XLS.secondSheetName])

    const contacts = book.Sheets.Contacts
    expect(contacts['!merges']).toHaveLength(1)
    expect(contacts['!merges']?.[0]).toMatchObject({
      s: { r: 0, c: 0 },
      e: { r: 0, c: 3 },
    })
    expect(contacts['!cols']?.[1]?.wch).toBe(30)
    expect(contacts['!rows']?.[0]?.hpt).toBe(24)
  })

  it('leaves untouched numeric cells and their formats alone', async () => {
    const { output } = await cleanRoundTrip(
      'customer contacts.xlsx',
      buildRichXlsx(),
    )

    const XLSX = await import('xlsx')
    const book = XLSX.read(await output.blob.arrayBuffer(), {
      type: 'array',
      cellStyles: true,
    })
    const roadmap = book.Sheets[XLS.secondSheetName]

    // Values we never flagged keep their type and their number format.
    expect(roadmap.C2?.t).toBe('n')
    expect(roadmap.C2?.v).toBe(1450000)
    expect(roadmap.C2?.z).toBe('#,##0')
  })

  it('names the output file with the sanitized suffix', async () => {
    const { output } = await cleanRoundTrip(
      'EMEA PAC — VIP session.xlsx',
      buildRichXlsx(),
    )
    expect(output.filename).toBe('EMEA PAC — VIP session — sanitized.xlsx')
  })

  it('leaves nothing sensitive behind on a full re-scan', async () => {
    const { cleaned, reopened } = await cleanRoundTrip(
      'customer contacts.xlsx',
      buildRichXlsx(),
    )

    const ours = new Set(cleaned.replacements.map((r) => r.replacement))
    const leaked = scan(reopened.text, {
      structuralDelimiter: reopened.structuralDelimiter,
    }).findings.filter((f) => !ours.has(f.value))

    expect(leaked.map((f) => `${f.category}:${f.value}`)).toEqual([])
  })
})
