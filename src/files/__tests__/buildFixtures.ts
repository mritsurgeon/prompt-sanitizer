import JSZip from 'jszip'
import * as XLSX from 'xlsx'

/**
 * Builds realistic Office fixtures in memory.
 *
 * Generated rather than committed as binaries so the exact structure under
 * test is visible here — in particular the runs deliberately split mid-name,
 * which is the case that breaks naive replacement.
 *
 * All content is fictional.
 */

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** A run carrying its own formatting. */
const run = (text: string, props = '') =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escape(text)}</w:t></w:r>`

const para = (runs: string, props = '') =>
  `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs}</w:p>`

const cell = (runs: string) =>
  `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${para(runs)}</w:tc>`

const row = (cells: string) => `<w:tr>${cells}</w:tr>`

export const DOCX_FIXTURE_FACTS = {
  /** Split across two runs: "John Sm" + "ith". */
  splitName: 'John Smith',
  email: 'sarah.mitchell@example.com',
  phone: '+27 82 555 0198',
  caseId: 'CASE-49281',
  tableName: 'Priya Naidoo',
  tableEmail: 'priya.naidoo@example.com',
  headerCompany: 'ACME Holdings',
  footerName: 'Thandeka Mokoena',
  footerEmail: 'thandeka.mokoena@example.com',
  customerId: 'CUST-839201',
}

export async function buildRichDocx(): Promise<ArrayBuffer> {
  const body = [
    // Heading, styled.
    para(run('Incident review', '<w:b/><w:sz w:val="32"/>'), '<w:pStyle w:val="Heading1"/>'),

    // A name split across two runs, the second of which is bold. This is the
    // case that a per-run replacement silently misses.
    para(
      run('Contact John Sm') +
        run('ith', '<w:b/>') +
        run(' about the renewal before Friday.'),
    ),

    // Several findings in one paragraph, with formatting in between.
    para(
      run('Email ') +
        run(DOCX_FIXTURE_FACTS.email, '<w:i/>') +
        run(' or call ') +
        run(DOCX_FIXTURE_FACTS.phone, '<w:b/>') +
        run(` about ${DOCX_FIXTURE_FACTS.caseId} for customer ${DOCX_FIXTURE_FACTS.customerId}.`),
    ),

    // Italic run that contains nothing sensitive — must survive untouched.
    para(run('This paragraph is entirely ') + run('unremarkable', '<w:i/>') + run('.')),

    // A table.
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>` +
      row(cell(run('Contact', '<w:b/>')) + cell(run('Email', '<w:b/>'))) +
      row(
        cell(run(DOCX_FIXTURE_FACTS.tableName)) +
          cell(run(DOCX_FIXTURE_FACTS.tableEmail)),
      ) +
      `</w:tbl>`,

    // Section properties wiring up the header and footer.
    `<w:sectPr><w:headerReference w:type="default" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><w:footerReference w:type="default" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></w:sectPr>`,
  ].join('')

  const zip = new JSZip()

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  )

  zip.folder('_rels')!.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  )

  const word = zip.folder('word')!

  word.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${body}</w:body></w:document>`,
  )

  word.file(
    'header1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${W_NS}>${para(run(`${DOCX_FIXTURE_FACTS.headerCompany} — CONFIDENTIAL`, '<w:b/>'))}</w:hdr>`,
  )

  word.file(
    'footer1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr ${W_NS}>${para(run(`Prepared by ${DOCX_FIXTURE_FACTS.footerName} · ${DOCX_FIXTURE_FACTS.footerEmail}`))}</w:ftr>`,
  )

  word.file(
    'styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
  )

  word.folder('_rels')!.file(
    'document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  )

  const blob = await zip.generateAsync({ type: 'arraybuffer' })
  return blob
}

export const XLSX_FIXTURE_FACTS = {
  name: 'Sarah Mitchell',
  email: 'sarah.mitchell@example.com',
  phone: '+27 82 555 0198',
  customerId: 'CUST-839201',
  secondSheetName: 'Roadmap',
  mergedTitle: 'Customer contacts — internal use only',
}

export function buildRichXlsx(): ArrayBuffer {
  const book = XLSX.utils.book_new()

  // --- sheet 1: contacts, with a merged title row and column widths --------
  const contacts = XLSX.utils.aoa_to_sheet([
    [XLSX_FIXTURE_FACTS.mergedTitle, '', '', ''],
    ['Contact', 'Email', 'Phone', 'Customer'],
    [
      XLSX_FIXTURE_FACTS.name,
      XLSX_FIXTURE_FACTS.email,
      XLSX_FIXTURE_FACTS.phone,
      XLSX_FIXTURE_FACTS.customerId,
    ],
    ['David Kruger', 'david.kruger@example.com', '+27 11 555 0142', 'CUST-839244'],
  ])

  contacts['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }]
  contacts['!cols'] = [{ wch: 24 }, { wch: 30 }, { wch: 18 }, { wch: 16 }]
  contacts['!rows'] = [{ hpt: 24 }]

  XLSX.utils.book_append_sheet(book, contacts, 'Contacts')

  // --- sheet 2: numbers, a formula and a number format --------------------
  const roadmap = XLSX.utils.aoa_to_sheet([
    ['Item', 'Quarter', 'Value'],
    ['Project Phoenix', 'Q3 2027', 1450000],
    ['Internal beta', 'Q4 2027', 890000],
  ])
  roadmap.D1 = { t: 's', v: 'Total' }
  roadmap.D2 = { t: 'n', v: 2340000, f: 'SUM(C2:C3)' }
  roadmap.C2 = { ...(roadmap.C2 as object), z: '#,##0' } as never

  XLSX.utils.book_append_sheet(book, roadmap, XLSX_FIXTURE_FACTS.secondSheetName)

  return XLSX.write(book, {
    bookType: 'xlsx',
    type: 'array',
    cellStyles: true,
  }) as ArrayBuffer
}
