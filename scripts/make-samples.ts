/**
 * Generates the demo files in `samples/` — `npm run samples`.
 *
 * Everything in them is fictional: invented names, example.com addresses,
 * reserved 555-01xx phone numbers and a fake key. Drag one onto the app to
 * demo the file path end to end.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'samples')
mkdirSync(out, { recursive: true })

// --------------------------------------------------------------------------
// CSV — a support case export
// --------------------------------------------------------------------------
const csvRows = [
  ['Case', 'Customer', 'Contact', 'Email', 'Phone', 'Server', 'IP', 'Status'],
  [
    'CASE-49281',
    'ACME Holdings',
    'Sarah Mitchell',
    'sarah.mitchell@example.com',
    '+27 82 555 0198',
    'SQL-PROD-04',
    '10.20.14.52',
    'Open',
  ],
  [
    'CASE-49307',
    'Northwind Traders',
    'David Kruger',
    'david.kruger@example.com',
    '+27 11 555 0142',
    'VBR-SRV-01',
    '10.20.14.61',
    'Open',
  ],
  [
    'CASE-49330',
    'Cygnus Logistics',
    'Priya Naidoo',
    'priya.naidoo@example.com',
    '+27 21 555 0177',
    'ESXI-HOST-12',
    '10.20.9.14',
    'Escalated',
  ],
  [
    'CASE-49355',
    'Vertex Foods',
    'Johan Botha',
    'johan.botha@example.com',
    '+27 31 555 0120',
    'FS-CORP-02',
    '10.20.31.8',
    'Waiting',
  ],
]

writeFileSync(
  join(out, 'support-cases.csv'),
  csvRows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n'),
)

// --------------------------------------------------------------------------
// XLSX — the same data plus a second sheet with contract values
// --------------------------------------------------------------------------
const book = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(
  book,
  XLSX.utils.aoa_to_sheet(csvRows),
  'Open cases',
)
XLSX.utils.book_append_sheet(
  book,
  XLSX.utils.aoa_to_sheet([
    ['Customer ID', 'Customer', 'Contract', 'Renewal', 'Value (ZAR)', 'Owner'],
    ['CUST-839201', 'ACME Holdings', 'CTR-778120', '2026-03-31', 1450000, 'Sarah Mitchell'],
    ['CUST-839244', 'Northwind Traders', 'CTR-778355', '2026-06-30', 890000, 'David Kruger'],
    ['CUST-839290', 'Cygnus Logistics', 'CTR-779010', '2026-01-31', 2310000, 'Priya Naidoo'],
    ['CUST-839311', 'Vertex Foods', 'CTR-779188', '2026-09-30', 640000, 'Johan Botha'],
  ]),
  'Contracts',
)
writeFileSync(
  join(out, 'customer-contracts.xlsx'),
  XLSX.write(book, { bookType: 'xlsx', type: 'buffer' }) as Buffer,
)

// --------------------------------------------------------------------------
// DOCX — a short incident write-up
// --------------------------------------------------------------------------
const paragraphs = [
  'Incident report — backup failure',
  '',
  'Case CASE-49281 was raised by Sarah Mitchell at ACME Holdings on 14 March. She can be reached on sarah.mitchell@example.com or +27 82 555 0198.',
  '',
  'The nightly job for SQL-PROD-04 (10.20.14.52) failed to write to \\\\BKP-REPO-01\\veeam-archive. The repository reported insufficient space at 02:14.',
  '',
  'This customer is CUST-839201 and contract CTR-778120 renews next month, so the account team has asked for a written root cause by Friday.',
  '',
  'Access for the review was made using the service key sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b. Rotate it once the review is closed.',
]

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs
      .map(
        (p) =>
          `<w:p><w:r><w:t xml:space="preserve">${escape(p)}</w:t></w:r></w:p>`,
      )
      .join('\n    ')}
  </w:body>
</w:document>`

const zip = new JSZip()
zip.file(
  '[Content_Types].xml',
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
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
word.file('document.xml', documentXml)
word.folder('_rels')!.file(
  'document.xml.rels',
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
)

const docx = await zip.generateAsync({ type: 'nodebuffer' })
writeFileSync(join(out, 'incident-report.docx'), docx)

console.log('Wrote samples/support-cases.csv')
console.log('Wrote samples/customer-contracts.xlsx')
console.log('Wrote samples/incident-report.docx')
