import type { CategoryId } from '../types'

/**
 * The labelled corpus behind the regression suite.
 *
 * `expect` — substrings that MUST be detected (optionally with a category).
 * `reject` — substrings that must NOT be detected at all. These are the
 *            false-positive traps: ordinary language that happens to look like
 *            a name, a company, an identifier or a number.
 *
 * Everything here is fictional. Public-company names are used only in cases
 * that assert we *don't* flag ordinary news-style sentences about them.
 */

export interface Case {
  name: string
  text: string
  expect?: { value: string; category?: CategoryId }[]
  reject?: string[]
}

// ---------------------------------------------------------------------------
// Ambiguous given names — words that are both a name and ordinary English.
// This is the single biggest source of false positives.
// ---------------------------------------------------------------------------
export const AMBIGUOUS_NAMES: Case[] = [
  {
    name: 'Christian as an adjective',
    text: 'Christian values are important to the organisation.',
    reject: ['Christian'],
  },
  {
    name: 'Christian as a person',
    text: 'Christian joined the meeting yesterday and raised two concerns.',
    expect: [{ value: 'Christian', category: 'PERSON' }],
  },
  {
    name: 'Christian corroborated by an email address',
    text: "Christian will pick this up. Christian's email address is christian@example.com.",
    expect: [
      { value: 'Christian', category: 'PERSON' },
      { value: 'christian@example.com', category: 'EMAIL' },
    ],
  },
  {
    name: 'Mark as a verb at sentence start',
    text: 'Mark the invoice as paid once the payment clears.',
    reject: ['Mark'],
  },
  {
    name: 'Mark as a person',
    text: 'Mark reviewed the invoice and approved it.',
    expect: [{ value: 'Mark', category: 'PERSON' }],
  },
  {
    name: 'May and June as months',
    text: 'May we schedule the review for June? The May release slipped a week.',
    reject: ['May', 'June'],
  },
  {
    name: 'Will as a modal verb',
    text: 'Will the backup job run again tonight, or will it wait for the window?',
    reject: ['Will'],
  },
  {
    name: 'Bill as a verb',
    text: 'Bill the customer for the extra hours we spent on the migration.',
    reject: ['Bill'],
  },
  {
    name: 'Frank as an adjective',
    text: 'We had a frank discussion about pricing. Frank feedback is welcome.',
    reject: ['Frank'],
  },
  {
    name: 'Faith, Grace, Hope, Art and Summer as nouns',
    text: 'Faith in the process matters. Grace period applies. Hope is not a strategy. The art of the possible. Summer release notes are attached.',
    reject: ['Faith', 'Grace', 'Hope', 'Art', 'Summer'],
  },
  {
    name: 'Rose as a person with a role cue',
    text: 'Rose from the finance team called about the renewal.',
    expect: [{ value: 'Rose', category: 'PERSON' }],
  },
  {
    name: 'Case consistency — same word lowercase elsewhere',
    text: 'Victor raised a concern. The victor of the bake-off was announced later.',
    reject: ['Victor'],
  },
  {
    name: 'Ambiguous name promoted by a surname',
    text: 'Frank Botha signed the renewal this morning.',
    expect: [{ value: 'Frank Botha', category: 'PERSON' }],
  },
]

// ---------------------------------------------------------------------------
// Companies, products and public information.
// ---------------------------------------------------------------------------
export const ORGANISATIONS: Case[] = [
  {
    name: 'Public company in a news sentence',
    text: 'Amazon released its quarterly results this morning and the market reacted well.',
    reject: ['Amazon'],
  },
  {
    name: 'Same company named as our customer',
    text: 'Amazon is our customer and their internal support contact is on leave.',
    expect: [{ value: 'Amazon', category: 'ORGANISATION' }],
  },
  {
    name: 'Company with a trading suffix',
    text: 'The renewal was signed by Northwind Traders Ltd last week.',
    expect: [{ value: 'Northwind Traders Ltd', category: 'ORGANISATION' }],
  },
  {
    name: 'Product and technology names',
    text: 'We run Kubernetes and Docker in production behind Windows Server, and the Microsoft Teams call is booked.',
    reject: ['Kubernetes', 'Docker', 'Windows Server', 'Microsoft Teams'],
  },
  {
    name: 'Publicly released product version',
    text: 'Veeam Backup & Replication 12.3 is generally available to all customers.',
    reject: ['Veeam Backup'],
  },
]

// ---------------------------------------------------------------------------
// Technical vocabulary, numbers, dates and standards.
// ---------------------------------------------------------------------------
export const TECHNICAL_NOISE: Case[] = [
  {
    name: 'Dates and times',
    text: 'The meeting is on 2024-03-15 at 14:30 and the follow-up is 15/04/2024.',
    reject: ['2024-03-15', '15/04/2024'],
  },
  {
    name: 'Version and build numbers',
    text: 'Version 12.1.2.4 shipped, and build 9.0.0.1420 is in staging.',
    reject: ['12.1.2.4', '9.0.0.1420'],
  },
  {
    name: 'Large quantities',
    text: 'We processed 1 234 567 records this quarter at a total cost of 45 000 000.',
    reject: ['1 234 567', '45 000 000'],
  },
  {
    name: 'Standards and specifications',
    text: 'ISO 27001 certification is in progress and we follow RFC 2119 keywords.',
    reject: ['ISO 27001', 'RFC 2119'],
  },
  {
    name: 'Fiscal periods',
    text: 'The FY-2024 numbers and the Q3-2025 forecast are both attached.',
    reject: ['FY-2024', 'Q3-2025'],
  },
  {
    name: 'Technical acronyms',
    text: 'Please review the SQL query, the API response and the DNS and DHCP settings.',
    reject: ['SQL', 'API', 'DNS', 'DHCP'],
  },
  {
    name: 'Error codes and percentages',
    text: 'Error code 0x80070005 appeared and our SLA is 99.99% uptime.',
    reject: ['0x80070005', '99.99'],
  },
  {
    name: 'Public documentation link',
    text: 'Our privacy policy is published at https://www.example.com/legal/privacy for anyone to read.',
    reject: ['https://www.example.com/legal/privacy'],
  },
]

// ---------------------------------------------------------------------------
// Real-world structured documents. These came from an actual feature-request
// tracker exported from .docx, where every row is its own short line — the
// shape that exposed three separate line-boundary bugs.
// ---------------------------------------------------------------------------
export const STRUCTURED_DOCUMENTS: Case[] = [
  {
    // A greedy phone match joined "12.1.0.2131" to the next row's "2" and
    // reached nine digits. Build numbers are not phone numbers, and nothing
    // should ever match across a line break.
    name: 'Release table with product build numbers',
    text: `Delivered
VBR 12.1.0.2131

2
Backup window termination for Unix Workloads
Planned after V13
Short-Term`,
    reject: ['12.1.0.2131', 'Unix Workloads', 'Backup window'],
  },
  {
    // The word after "Unix Workloads" is on the *next* line ("Planned"), which
    // is in the person-verb list. Context must not cross line boundaries.
    name: 'Tracker rows with technical vocabulary',
    text: `8
SNMP traps are not being sent for the 'OnVmBackupCompleted' class for Agents
PM Reviewed
Short-Term

9
File and Folder wildcards for Veeam Agent for Windows, Linux, AIX`,
    reject: [
      'SNMP',
      'OnVmBackupCompleted',
      'PM Reviewed',
      'Veeam Agent',
      'Windows',
      'Linux',
      'AIX',
      'Folder',
    ],
  },
  {
    name: 'Version numbers next to a row number',
    text: `Fixed in 9.0.0.1420
3
Awaiting triage`,
    reject: ['9.0.0.1420'],
  },
  {
    // The regression guard: a real phone number in a line-oriented document
    // must still be found.
    name: 'Genuine contact details in a line-oriented document',
    text: `Reported by
Sarah Mitchell
+27 82 555 0198
sarah.mitchell@example.com`,
    expect: [
      { value: 'Sarah Mitchell', category: 'PERSON' },
      { value: '+27 82 555 0198', category: 'PHONE' },
      { value: 'sarah.mitchell@example.com', category: 'EMAIL' },
    ],
  },
]

// ---------------------------------------------------------------------------
// CVs and profiles. Dense with job titles, qualifications and institutions
// sitting exactly where a name would sit — and with the one name that matters
// alone on the first line.
// ---------------------------------------------------------------------------
export const PROFILE_DOCUMENTS: Case[] = [
  {
    // An ASCII-only token pattern splits "Mornè" into "Morn" + "è" and loses
    // the name entirely. The names that breaks are disproportionately the
    // non-English ones.
    name: 'Accented name on the opening line',
    text: `Mornè Jonker
Senior Solutions Architect
Location: Pretoria, South Africa`,
    expect: [
      { value: 'Mornè Jonker', category: 'PERSON' },
      { value: 'Pretoria', category: 'LOCATION' },
    ],
    // A country identifies nobody, so masking it costs readability and buys no
    // privacy. It is listed in the gazetteer only so it is not mistaken for an
    // unrecognised name.
    reject: ['Senior Solutions Architect', 'South Africa'],
  },
  {
    // Both names carry ordinary supporting context, so this isolates the
    // tokenising question — can an accented name be seen at all — rather than
    // re-testing context scoring, which the cases above already cover.
    name: 'Other accented and non-English names',
    text: 'Please contact José Müller. Renée Dubois will follow up afterwards.',
    expect: [
      { value: 'José Müller', category: 'PERSON' },
      { value: 'Renée Dubois', category: 'PERSON' },
    ],
  },
  {
    name: 'Job titles are not people',
    text: `Implementation Specialist / Team Lead
Mission Critical Engineer / Technical Consultant
HPE Storage Ambassador for South Africa`,
    reject: [
      'Implementation Specialist',
      'Technical Consultant',
      'Storage Ambassador',
      'Team Lead',
    ],
  },
  {
    name: 'Institutions and qualifications are not people',
    text: `S3 Level (Electrical Engineering/Electronics) – Pretoria Technicon
Transvaal Senior Certificate – Hoër Tegniese Skool Springs
Clariion Host Integration, Compaq ASE Professional, Brocade BCFP.`,
    reject: [
      'Pretoria Technicon',
      'Hoër Tegniese Skool',
      'Electrical Engineering',
      'Clariion Host Integration',
      'Compaq ASE Professional',
    ],
  },
  {
    name: 'A generic modifier does not make a company',
    text: 'Strategic Consulting: TCO/ROI calculation using Allinean tools.',
    reject: ['Strategic Consulting'],
  },
  {
    name: 'Real employers are still companies',
    text: 'Hewlett Packard Enterprise (HPE) | October 2023 – Present. I work for Veeam Software.',
    expect: [{ value: 'Veeam Software', category: 'ORGANISATION' }],
  },
  {
    name: 'Contractions are not names',
    text: "Before our starters arrive, I'd like to invite you in. I'm sure I'll be there.",
    reject: ["I'd", "I'm", "I'll"],
  },
]

// ---------------------------------------------------------------------------
// Places.
// ---------------------------------------------------------------------------
export const PLACES: Case[] = [
  {
    name: 'Place as a generic modifier',
    text: 'The London office moved floors and the Berlin team is hiring.',
    reject: ['London', 'Berlin'],
  },
  {
    name: 'Place in a locative context',
    text: 'The customer site is in Johannesburg, near the depot.',
    expect: [{ value: 'Johannesburg', category: 'LOCATION' }],
  },
]

// ---------------------------------------------------------------------------
// True positives that must keep working. These are the regression guard.
// ---------------------------------------------------------------------------
export const TRUE_POSITIVES: Case[] = [
  {
    name: 'Contact details',
    text: 'Please contact Sarah Mitchell on sarah.mitchell@example.com or +27 82 555 0198.',
    expect: [
      { value: 'Sarah Mitchell', category: 'PERSON' },
      { value: 'sarah.mitchell@example.com', category: 'EMAIL' },
      { value: '+27 82 555 0198', category: 'PHONE' },
    ],
  },
  {
    name: 'Infrastructure',
    text: 'The affected server is SQL-PROD-04 at 10.20.14.52 writing to \\\\BKP-REPO-01\\veeam-archive.',
    expect: [
      { value: 'SQL-PROD-04', category: 'INTERNAL_HOST' },
      { value: '10.20.14.52', category: 'IP_ADDRESS' },
      { value: '\\\\BKP-REPO-01\\veeam-archive', category: 'NETWORK_PATH' },
    ],
  },
  {
    name: 'Business identifiers',
    text: 'This is customer CUST-839201, support case CASE-49281, contract CTR-778120.',
    expect: [
      { value: 'CUST-839201', category: 'CUSTOMER_ID' },
      { value: 'CASE-49281', category: 'CASE_ID' },
      { value: 'CTR-778120', category: 'CONTRACT_ID' },
    ],
  },
  {
    name: 'Credentials and secrets',
    text: 'Use the key sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b and password = Summer2024! to sign in.',
    expect: [
      { value: 'sk-live-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b', category: 'API_KEY' },
      { value: 'Summer2024!', category: 'PASSWORD' },
    ],
  },
  {
    name: 'Payment card and ID number',
    text: 'Card 4111 1111 1111 1111 was charged and the SSN on file is 123-45-6789.',
    expect: [
      { value: '4111 1111 1111 1111', category: 'CREDIT_CARD' },
      { value: '123-45-6789', category: 'NATIONAL_ID' },
    ],
  },
  {
    name: 'Titled name and street address',
    text: 'Dear Mr Patel, the delivery goes to 42 Rivonia Road, Sandton.',
    expect: [
      { value: 'Patel', category: 'PERSON' },
      { value: '42 Rivonia Road', category: 'POSTAL_ADDRESS' },
    ],
  },
  {
    // The token is the sensitive part, so flagging it beats flagging the whole
    // link — the cleaned text keeps a usable URL shape.
    name: 'Token inside a URL',
    text: 'Reset here: https://portal.example.com/reset?token=a91f3c7de84b2109ff5a',
    expect: [{ value: 'a91f3c7de84b2109ff5a', category: 'API_KEY' }],
  },
]

export const ALL_CASES: { group: string; cases: Case[] }[] = [
  { group: 'ambiguous names', cases: AMBIGUOUS_NAMES },
  { group: 'organisations', cases: ORGANISATIONS },
  { group: 'technical noise', cases: TECHNICAL_NOISE },
  { group: 'structured documents', cases: STRUCTURED_DOCUMENTS },
  { group: 'profile documents', cases: PROFILE_DOCUMENTS },
  { group: 'places', cases: PLACES },
  { group: 'true positives', cases: TRUE_POSITIVES },
]
