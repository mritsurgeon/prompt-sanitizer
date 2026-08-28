/**
 * The classification taxonomy: what a document is *about*, what kind of
 * document it *is*, and which part of the business it belongs to.
 *
 * These are three genuinely different questions, so they are three separate
 * dimensions rather than one flat label set. A Master Services Agreement is
 * `documentType: contract`, `topic: legal + intellectual property`,
 * `function: legal department` — and all three are useful for different
 * reasons.
 *
 * Everything here is plain data. Adding a category, or teaching an existing one
 * a new house phrase, needs no code change.
 */

export type Dimension = 'topic' | 'documentType' | 'function'

export interface ClassDefinition {
  id: string
  /** Shown to the user. Sentence case, no jargon. */
  label: string
  dimension: Dimension
  /**
   * Near-canonical signatures. A document containing "NON-DISCLOSURE
   * AGREEMENT" is an NDA; there is very little to argue about.
   */
  patterns?: RegExp[]
  /** Phrases that strongly indicate this class. */
  strong?: string[]
  /** Supporting vocabulary — weak individually, meaningful in aggregate. */
  terms?: string[]
  /** Evidence against, to stop neighbouring classes bleeding into each other. */
  against?: string[]
}

// ---------------------------------------------------------------------------
// What kind of document is this?
// ---------------------------------------------------------------------------
export const DOCUMENT_TYPES: ClassDefinition[] = [
  {
    id: 'nda',
    label: 'Non-disclosure agreement',
    dimension: 'documentType',
    patterns: [
      /\bnon[-\s]?disclosure agreement\b/i,
      /\bmutual non[-\s]?disclosure\b/i,
      /\bconfidentiality agreement\b/i,
      /\bNDA\b/,
    ],
    strong: ['receiving party', 'disclosing party', 'shall not disclose'],
    terms: ['confidential information', 'trade secret', 'permitted purpose'],
  },
  {
    id: 'msa',
    label: 'Master services agreement',
    dimension: 'documentType',
    patterns: [/\bmaster services? agreement\b/i, /\bMSA\b/],
    strong: ['services agreement', 'order form', 'service levels'],
    terms: ['the parties', 'governing law', 'term and termination'],
  },
  {
    id: 'sow',
    label: 'Statement of work',
    dimension: 'documentType',
    patterns: [/\bstatement of work\b/i, /\bSOW\b/],
    strong: ['deliverables', 'acceptance criteria', 'scope of work'],
    terms: ['milestones', 'assumptions', 'out of scope', 'project plan'],
  },
  {
    id: 'contract',
    label: 'Contract or agreement',
    dimension: 'documentType',
    patterns: [
      /\bthis agreement is (?:made|entered)\b/i,
      /\bin witness whereof\b/i,
      /\bhereinafter referred to as\b/i,
    ],
    strong: ['governing law', 'indemnif', 'the parties agree', 'termination for convenience'],
    terms: ['clause', 'whereas', 'liability', 'warranty', 'counterparts', 'force majeure'],
    // A more specific agreement type should win.
    against: ['non-disclosure agreement', 'statement of work'],
  },
  {
    id: 'invoice',
    label: 'Invoice',
    dimension: 'documentType',
    patterns: [
      /\binvoice\s*(?:no|number|nr|#)\b/i,
      /\btax invoice\b/i,
      /\bamount due\b/i,
    ],
    strong: ['due date', 'subtotal', 'total due', 'remit to', 'vat number'],
    terms: ['quantity', 'unit price', 'payment terms', 'bank details'],
  },
  {
    id: 'purchase_order',
    label: 'Purchase order',
    dimension: 'documentType',
    patterns: [/\bpurchase order\b/i, /\bPO\s*(?:no|number|#)\b/i],
    strong: ['ship to', 'bill to', 'order date'],
    terms: ['unit price', 'quantity', 'delivery date', 'requisition'],
    against: ['invoice no'],
  },
  {
    id: 'quote',
    label: 'Quote or proposal',
    dimension: 'documentType',
    patterns: [/\bquotation\b/i, /\bpricing proposal\b/i, /\bvalid until\b/i],
    strong: ['pricing summary', 'scope of supply', 'commercial proposal'],
    terms: ['list price', 'discount', 'total investment', 'optional items'],
  },
  {
    id: 'meeting_notes',
    label: 'Meeting notes',
    dimension: 'documentType',
    patterns: [/\bminutes of (?:the )?meeting\b/i, /\bmeeting notes\b/i],
    strong: ['attendees', 'action items', 'apologies', 'next meeting'],
    terms: ['agenda', 'discussion', 'decisions', 'owner', 'due'],
  },
  {
    id: 'policy',
    label: 'Policy document',
    dimension: 'documentType',
    patterns: [/\bthis policy (?:applies|sets out)\b/i, /\bpolicy statement\b/i],
    strong: ['responsibilities', 'scope of this policy', 'policy owner'],
    terms: ['compliance', 'review date', 'version control', 'must', 'employees'],
  },
  {
    id: 'specification',
    label: 'Design or specification',
    dimension: 'documentType',
    patterns: [
      /\bhigh[-\s]level design\b/i,
      /\blow[-\s]level design\b/i,
      /\bdesign document\b/i,
      /\bfunctional specification\b/i,
    ],
    strong: ['requirements', 'architecture', 'data flow', 'interfaces'],
    terms: ['assumptions', 'constraints', 'components', 'schema', 'api'],
  },
  {
    id: 'roadmap',
    label: 'Roadmap or plan',
    dimension: 'documentType',
    patterns: [/\bproduct roadmap\b/i, /\bdelivery plan\b/i, /\broadmap\b/i],
    strong: ['milestone', 'backlog', 'release schedule', 'target date'],
    terms: ['quarter', 'phase', 'epic', 'planned', 'delivered', 'short-term'],
  },
  {
    id: 'report',
    label: 'Report',
    dimension: 'documentType',
    patterns: [/\bexecutive summary\b/i, /\bincident report\b/i, /\bstatus report\b/i],
    strong: ['findings', 'recommendations', 'conclusion', 'methodology'],
    terms: ['background', 'analysis', 'appendix', 'summary'],
  },
  {
    id: 'support_case',
    label: 'Support case',
    dimension: 'documentType',
    patterns: [/\bcase\s*(?:no|number|#)\b/i, /\bticket\s*(?:no|number|#)\b/i],
    strong: ['root cause', 'workaround', 'resolution', 'severity'],
    terms: ['reported by', 'steps to reproduce', 'log', 'escalated'],
  },
  {
    id: 'correspondence',
    label: 'Email or letter',
    dimension: 'documentType',
    patterns: [/^\s*(?:from|to|subject|cc)\s*:/im, /\bdear (?:sir|madam|mr|mrs|ms)\b/i],
    strong: ['kind regards', 'best regards', 'yours sincerely', 'yours faithfully'],
    terms: ['hi team', 'thanks', 'please find attached', 'following up'],
  },
  {
    id: 'cv',
    label: 'CV or résumé',
    dimension: 'documentType',
    patterns: [/\bcurriculum vitae\b/i, /\bwork experience\b/i],
    strong: ['education', 'employment history', 'references available'],
    terms: ['skills', 'qualifications', 'achievements', 'languages'],
  },
  {
    id: 'payslip',
    label: 'Payslip or payroll',
    dimension: 'documentType',
    patterns: [/\bpay\s?slip\b/i, /\bpayroll (?:report|register)\b/i],
    strong: ['gross pay', 'net pay', 'deductions'],
    terms: ['tax code', 'paye', 'uif', 'pension', 'earnings'],
  },
]

// ---------------------------------------------------------------------------
// What is it about?
// ---------------------------------------------------------------------------
export const TOPICS: ClassDefinition[] = [
  {
    id: 'ip',
    label: 'Intellectual property',
    dimension: 'topic',
    patterns: [/\bintellectual property\b/i, /\btrade secrets?\b/i],
    strong: ['patent', 'trademark', 'copyright', 'proprietary technology', 'know-how'],
    terms: ['invention', 'licence', 'license', 'source code', 'proprietary', 'royalty'],
  },
  {
    id: 'legal',
    label: 'Legal',
    dimension: 'topic',
    patterns: [/\bgoverning law\b/i, /\bindemnif/i],
    strong: ['liability', 'jurisdiction', 'breach of contract', 'dispute resolution'],
    terms: ['clause', 'agreement', 'contract', 'warranty', 'compliance', 'regulation', 'gdpr', 'popia'],
  },
  {
    id: 'sales',
    label: 'Sales',
    dimension: 'topic',
    patterns: [/\bsales pipeline\b/i, /\bwin rate\b/i],
    strong: ['opportunity', 'quota', 'renewal', 'close date', 'prospect'],
    terms: ['deal', 'discount', 'forecast', 'proposal', 'account', 'upsell', 'churn'],
  },
  {
    id: 'finance',
    label: 'Finance',
    dimension: 'topic',
    patterns: [/\bcash flow\b/i, /\bp&l\b/i, /\bebitda\b/i],
    strong: [
      'revenue',
      'margin',
      'budget',
      'accrual',
      'reconciliation',
      'invoice',
      'payment terms',
      'total due',
      'subtotal',
    ],
    terms: ['cost', 'expense', 'tax', 'vat', 'payment', 'variance', 'amount'],
  },
  {
    id: 'hr',
    label: 'People and HR',
    dimension: 'topic',
    patterns: [/\bperformance review\b/i, /\bdisciplinary\b/i],
    strong: [
      'recruitment',
      'onboarding',
      'grievance',
      'headcount',
      'remuneration',
      'gross pay',
      'net pay',
      'payroll',
      'deductions',
    ],
    terms: [
      'employee',
      'leave',
      'salary',
      'benefits',
      'probation',
      'appraisal',
      'paye',
      'tax code',
      'pension',
    ],
  },
  {
    id: 'it_security',
    label: 'IT and security',
    dimension: 'topic',
    patterns: [/\baccess control\b/i, /\bvulnerability\b/i],
    strong: ['firewall', 'malware', 'encryption', 'authentication', 'incident response'],
    terms: ['server', 'network', 'backup', 'patch', 'outage', 'database', 'restore', 'repository'],
  },
  {
    id: 'procurement',
    label: 'Procurement',
    dimension: 'topic',
    patterns: [/\brequest for proposal\b/i, /\btender\b/i],
    strong: ['supplier', 'sourcing', 'contract award', 'lead time'],
    terms: ['vendor', 'purchase order', 'rfp', 'rfq', 'quotation', 'buyer'],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    dimension: 'topic',
    patterns: [/\bgo[-\s]to[-\s]market\b/i, /\blead generation\b/i],
    strong: ['campaign', 'brand', 'positioning', 'messaging'],
    terms: ['collateral', 'webinar', 'seo', 'launch', 'audience', 'creative'],
  },
  {
    id: 'product',
    label: 'Product',
    dimension: 'topic',
    patterns: [/\buser story\b/i, /\bfeature request\b/i],
    strong: ['roadmap', 'backlog', 'release', 'specification'],
    terms: ['feature', 'requirement', 'beta', 'enhancement', 'defect', 'sprint'],
  },
  {
    id: 'operations',
    label: 'Operations',
    dimension: 'topic',
    patterns: [/\bservice level agreement\b/i, /\brunbook\b/i],
    strong: ['escalation', 'workflow', 'capacity', 'throughput'],
    terms: ['process', 'sla', 'ticket', 'queue', 'shift', 'handover'],
  },
]

// ---------------------------------------------------------------------------
// Whose is it?
// ---------------------------------------------------------------------------
export const FUNCTIONS: ClassDefinition[] = [
  {
    id: 'legal_dept',
    label: 'Legal',
    dimension: 'function',
    patterns: [/\blegal (?:team|department)\b/i, /\bgeneral counsel\b/i, /\blegal@/i],
    strong: ['contracts team', 'company secretary', 'in-house counsel'],
    terms: ['paralegal', 'compliance officer'],
  },
  {
    id: 'sales_dept',
    label: 'Sales',
    dimension: 'function',
    patterns: [/\bsales (?:team|department)\b/i, /\bsales@/i],
    strong: ['account manager', 'account executive', 'sales director', 'pre-sales'],
    terms: ['territory', 'sales engineer', 'channel partner'],
  },
  {
    id: 'finance_dept',
    label: 'Finance',
    dimension: 'function',
    patterns: [/\bfinance (?:team|department)\b/i, /\baccounts (?:payable|receivable)\b/i, /\bfinance@/i],
    strong: ['financial controller', 'cfo', 'bookkeeper'],
    terms: ['credit control', 'treasury'],
  },
  {
    id: 'hr_dept',
    label: 'HR',
    dimension: 'function',
    patterns: [/\bhuman resources\b/i, /\bhr (?:team|department)\b/i, /\bhr@/i],
    strong: ['people team', 'talent acquisition', 'chro'],
    terms: ['hr business partner', 'payroll team'],
  },
  {
    id: 'it_dept',
    label: 'IT',
    dimension: 'function',
    patterns: [/\bit (?:team|department)\b/i, /\bservice desk\b/i, /\bhelpdesk\b/i, /\bit@/i],
    strong: ['infrastructure team', 'sysadmin', 'ciso', 'security operations'],
    terms: ['network team', 'platform team', 'noc', 'soc'],
  },
  {
    id: 'procurement_dept',
    label: 'Procurement',
    dimension: 'function',
    patterns: [/\bprocurement (?:team|department)\b/i, /\bpurchasing department\b/i, /\bprocurement@/i],
    strong: ['sourcing team', 'category manager'],
    terms: ['buyer', 'supplier manager'],
  },
  {
    id: 'marketing_dept',
    label: 'Marketing',
    dimension: 'function',
    patterns: [/\bmarketing (?:team|department)\b/i, /\bmarketing@/i],
    strong: ['brand team', 'demand generation'],
    terms: ['content team', 'events team'],
  },
  {
    id: 'engineering_dept',
    label: 'Engineering',
    dimension: 'function',
    patterns: [/\b(?:engineering|development|product) team\b/i, /\bdev team\b/i],
    strong: ['qa team', 'platform engineering', 'scrum team'],
    terms: ['tech lead', 'architect', 'release manager'],
  },
  {
    id: 'support_dept',
    label: 'Support',
    dimension: 'function',
    patterns: [/\b(?:customer|technical) support\b/i, /\bsupport (?:team|desk)\b/i, /\bsupport@/i],
    strong: ['service delivery', 'support engineer'],
    terms: ['first line', 'second line', 'escalation engineer'],
  },
  {
    id: 'executive',
    label: 'Executive',
    dimension: 'function',
    patterns: [/\bboard of directors\b/i, /\bexecutive (?:team|committee)\b/i, /\bexco\b/i],
    strong: ['leadership team', 'steering committee', 'board pack'],
    terms: ['ceo', 'coo', 'managing director'],
  },
]

/**
 * A document's *kind* implies its subject even when the subject vocabulary is
 * absent. A purchase order is about procurement but never uses the word — it
 * says "ship to", "requisition", "buyer". Used only when no topic was detected
 * directly, and marked as inferred.
 */
export const DOCUMENT_TYPE_TO_TOPIC: Record<string, string> = {
  nda: 'legal',
  msa: 'legal',
  sow: 'legal',
  contract: 'legal',
  invoice: 'finance',
  purchase_order: 'procurement',
  quote: 'sales',
  payslip: 'hr',
  cv: 'hr',
  specification: 'it_security',
  support_case: 'it_security',
  report: 'operations',
  meeting_notes: 'operations',
  roadmap: 'product',
}

/**
 * When a document's subject is clear but nobody names a department, the owning
 * function can be inferred — at reduced confidence, and labelled as inferred.
 */
export const TOPIC_TO_FUNCTION: Record<string, string> = {
  ip: 'legal_dept',
  legal: 'legal_dept',
  sales: 'sales_dept',
  finance: 'finance_dept',
  hr: 'hr_dept',
  it_security: 'it_dept',
  procurement: 'procurement_dept',
  marketing: 'marketing_dept',
  product: 'engineering_dept',
  operations: 'support_dept',
}

/**
 * Filename hints per document type — "MSA_ACME_2027.docx" says a lot.
 *
 * Acronyms use letter-only lookarounds rather than `\b`, because `_` counts as
 * a word character: `\bsow\b` does not match "SOW_migration.docx", which is
 * exactly how these files are usually named.
 */
export const FILENAME_HINTS: Record<string, RegExp> = {
  nda: /(?<![a-z])nda(?![a-z])|non[-_ ]?disclosure/i,
  msa: /(?<![a-z])msa(?![a-z])|master[-_ ]?services?/i,
  sow: /(?<![a-z])sow(?![a-z])|statement[-_ ]?of[-_ ]?work/i,
  contract: /contract|agreement/i,
  invoice: /invoice|\binv[-_ ]?\d/i,
  purchase_order: /\bpo[-_ ]?\d|purchase[-_ ]?order/i,
  quote: /quote|quotation|proposal/i,
  meeting_notes: /minutes|meeting[-_ ]?notes/i,
  policy: /policy/i,
  specification: /\bhld\b|\blld\b|design|spec\b/i,
  roadmap: /roadmap|tracker|backlog/i,
  report: /report/i,
  support_case: /case[-_ ]?\d|ticket[-_ ]?\d/i,
  cv: /(?<![a-z])cv(?![a-z])|resume|curriculum/i,
  payslip: /payslip|payroll/i,
}

/** Document types that usually imply the content should stay internal. */
export const SENSITIVE_DOCUMENT_TYPES = new Set([
  'nda',
  'msa',
  'sow',
  'contract',
  'quote',
  'roadmap',
  'specification',
  'payslip',
  'cv',
])

/** Topics that usually imply the content should stay internal. */
export const SENSITIVE_TOPICS = new Set(['ip', 'legal', 'finance', 'hr', 'sales'])
