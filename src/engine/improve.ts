/**
 * Local prompt improvement.
 *
 * This runs entirely on the machine — no model call, no network. It reads the
 * *sanitized* text only (the caller never passes the original in), works out
 * what the person is actually asking for, and rewrites it as a clear,
 * structured instruction.
 *
 * Deliberately rule-based: it is instant, it is predictable in a demo, and it
 * cannot leak anything because there is nowhere for the text to go.
 */

export type Intent =
  | 'troubleshoot'
  | 'summarise'
  | 'draft'
  | 'analyse'
  | 'explain'
  | 'review'
  | 'code'
  | 'general'

export interface ImprovedPrompt {
  text: string
  intent: Intent
  /** Short plain-English note shown above the result. */
  note: string
}

const INTENT_KEYWORDS: Record<Intent, string[]> = {
  troubleshoot: [
    'fail',
    'failed',
    'failing',
    'failure',
    'error',
    'errors',
    'issue',
    'problem',
    'broken',
    'crash',
    'crashed',
    'not working',
    'does not work',
    'doesn’t work',
    'timeout',
    'timed out',
    'stuck',
    'hung',
    'unable',
    'cannot',
    'troubleshoot',
    'diagnose',
    'root cause',
    'why did',
    'why is',
    'debug',
  ],
  summarise: [
    'summarise',
    'summarize',
    'summary',
    'tl;dr',
    'key points',
    'main points',
    'brief me',
    'overview',
    'recap',
    'digest',
  ],
  draft: [
    'write',
    'draft',
    'reply',
    'respond',
    'response',
    'email',
    'e-mail',
    'message',
    'letter',
    'note to',
    'communicate',
    'announcement',
    'update the customer',
  ],
  analyse: [
    'analyse',
    'analyze',
    'analysis',
    'trend',
    'trends',
    'insight',
    'insights',
    'spreadsheet',
    'data',
    'numbers',
    'figures',
    'report',
    'compare',
    'breakdown',
    'statistics',
    'forecast',
  ],
  explain: [
    'explain',
    'what is',
    'what are',
    'how does',
    'how do',
    'meaning of',
    'difference between',
    'help me understand',
  ],
  review: [
    'review',
    'feedback',
    'improve this',
    'check this',
    'proofread',
    'critique',
    'sanity check',
    'is this correct',
  ],
  code: [
    'code',
    'script',
    'function',
    'powershell',
    'python',
    'bash',
    'sql query',
    'javascript',
    'regex',
    'stack trace',
    'exception',
    'compile',
  ],
  general: [],
}

const DOMAINS: { id: string; label: string; words: string[] }[] = [
  {
    id: 'backup',
    label: 'backup and recovery',
    words: [
      'backup',
      'restore',
      'recovery',
      'repository',
      'snapshot',
      'replica',
      'replication',
      'retention',
      'tape',
      'immutable',
      'veeam',
      'vbr',
      'job run',
    ],
  },
  {
    id: 'virtualisation',
    label: 'virtualisation',
    words: ['vmware', 'esxi', 'vcenter', 'hyper-v', 'virtual machine', 'vm ', 'hypervisor', 'datastore'],
  },
  {
    id: 'database',
    label: 'database',
    words: ['sql', 'database', 'query', 'index', 'deadlock', 'table', 'postgres', 'oracle'],
  },
  {
    id: 'network',
    label: 'network',
    words: ['network', 'firewall', 'vlan', 'latency', 'dns', 'vpn', 'packet', 'routing', 'bandwidth', 'port'],
  },
  {
    id: 'security',
    label: 'security',
    words: ['security', 'breach', 'malware', 'ransomware', 'phishing', 'vulnerability', 'audit', 'compliance'],
  },
  {
    id: 'storage',
    label: 'storage',
    words: ['storage', 'disk', 'volume', 'lun', 'nas', 'san', 'capacity', 'quota'],
  },
]

const GREETING_RE =
  /^(?:hi|hey|hello|good (?:morning|afternoon|evening))\b[^.\n]*[,.]?\s*/i

const FILLER_RE =
  /^(?:please\s+|can you\s+|could you\s+|would you\s+|i need (?:you )?to\s+|i want (?:you )?to\s+|help me\s+(?:to\s+)?|pls\s+|just\s+)+/i

const countHits = (haystack: string, needles: string[]) =>
  needles.reduce((n, needle) => (haystack.includes(needle) ? n + 1 : n), 0)

function detectIntent(text: string): Intent {
  const lower = text.toLowerCase()
  let best: Intent = 'general'
  let bestScore = 0

  for (const key of Object.keys(INTENT_KEYWORDS) as Intent[]) {
    const score = countHits(lower, INTENT_KEYWORDS[key])
    if (score > bestScore) {
      bestScore = score
      best = key
    }
  }
  return best
}

function detectDomain(text: string): string | null {
  const lower = text.toLowerCase()
  let best: string | null = null
  let bestScore = 0
  for (const domain of DOMAINS) {
    const score = countHits(lower, domain.words)
    if (score > bestScore) {
      bestScore = score
      best = domain.label
    }
  }
  return best
}

/** Does this text carry its own data/context, or is it just an instruction? */
function hasContextBlock(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length > 2) return true
  if (text.length > 220) return true
  return false
}

/** Turn a rambling first sentence into a single clean task line. */
function extractAsk(text: string): string {
  const firstChunk = text.split(/\n\s*\n/)[0] ?? text
  const sentence = firstChunk.split(/(?<=[.?!])\s+/)[0] ?? firstChunk

  let ask = sentence
    .replace(GREETING_RE, '')
    .replace(FILLER_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?.!]+$/, '')

  if (ask.length > 160) ask = ask.slice(0, 157).trimEnd() + '…'
  return ask
}

function subjectFrom(ask: string, domain: string | null): string {
  if (domain) return `${domain} question`
  const words = ask.split(' ').slice(0, 8).join(' ')
  return words.length > 3 ? words.toLowerCase() : 'request'
}

interface Template {
  lead: (ctx: TemplateContext) => string
  steps: (ctx: TemplateContext) => string[]
  note: string
}

interface TemplateContext {
  ask: string
  domain: string | null
  subject: string
  where: string
}

const TEMPLATES: Record<Intent, Template> = {
  troubleshoot: {
    note: 'Rewritten as a structured troubleshooting request.',
    lead: ({ domain, where }) =>
      `Act as an experienced ${domain ?? 'IT'} engineer. Diagnose the problem described ${where}.`,
    steps: () => [
      'Identify the three most likely root causes, ordered by likelihood.',
      'For each cause, state the evidence that would confirm or rule it out — the specific logs, settings or checks to look at.',
      'Recommend the single next step to take first, and why.',
    ],
  },
  summarise: {
    note: 'Rewritten as a focused summary request.',
    lead: ({ where }) => `Summarise the content ${where} for a busy colleague.`,
    steps: () => [
      'Open with a three-sentence overview.',
      'List the key points as short bullets, most important first.',
      'Call out any decisions, risks, owners or deadlines mentioned.',
    ],
  },
  draft: {
    note: 'Rewritten as a clear writing brief.',
    lead: ({ ask, where }) =>
      `${ask ? ask.charAt(0).toUpperCase() + ask.slice(1) : 'Draft a professional reply'}, using the information ${where}.`,
    steps: () => [
      'Keep it under 150 words, professional and easy to scan.',
      'Acknowledge the situation, say what happens next, and give a timeframe.',
      'Stay factual — do not promise anything the notes do not support.',
    ],
  },
  analyse: {
    note: 'Rewritten as an analysis brief.',
    lead: ({ where }) => `Analyse the data ${where} and tell me what it shows.`,
    steps: () => [
      'Describe the three most significant patterns, outliers or anomalies.',
      'Quantify each one — which values, how large the effect, over what period.',
      'Recommend what to investigate or act on next.',
    ],
  },
  explain: {
    note: 'Rewritten as a clear explanation request.',
    lead: ({ ask, where }) =>
      `Explain ${ask ? ask.replace(/^explain\s+/i, '') : `the topic ${where}`} clearly, for a knowledgeable but non-specialist reader.`,
    steps: () => [
      'Start with a two-sentence plain-English definition.',
      'Explain why it matters in practice, with one concrete example.',
      'Note the most common misunderstanding about it.',
    ],
  },
  review: {
    note: 'Rewritten as a review brief.',
    lead: ({ where }) => `Review the content ${where} critically.`,
    steps: () => [
      'Point out anything unclear, inconsistent, missing or incorrect — quote the exact text.',
      'Suggest a specific improvement for each issue.',
      'Finish with a corrected version.',
    ],
  },
  code: {
    note: 'Rewritten as a technical code request.',
    lead: ({ domain, where }) =>
      `Act as an experienced ${domain ?? 'software'} engineer. Work through the code ${where}.`,
    steps: () => [
      'Explain what the code does and exactly where it goes wrong.',
      'Provide a corrected version, commenting only the non-obvious logic.',
      'List the edge cases worth testing.',
    ],
  },
  general: {
    note: 'Rewritten as a clearer, more specific instruction.',
    lead: ({ ask, subject, where }) =>
      ask
        ? `${ask.charAt(0).toUpperCase() + ask.slice(1)}, using the information ${where}.`
        : `Help with the ${subject} ${where}.`,
    steps: () => [
      'Answer directly first, then give the reasoning behind it.',
      'Flag anything you are uncertain about, and what extra detail would sharpen the answer.',
      'Finish with a recommended next step.',
    ],
  },
}

export function improvePrompt(sanitized: string): ImprovedPrompt {
  const text = sanitized.trim()

  if (!text) {
    return { text: '', intent: 'general', note: 'Nothing to improve yet.' }
  }

  const intent = detectIntent(text)
  const domain = detectDomain(text)
  const ask = extractAsk(text)
  const withContext = hasContextBlock(text)
  const ctx: TemplateContext = {
    ask,
    domain,
    subject: subjectFrom(ask, domain),
    where: withContext ? 'below' : 'here',
  }

  const template = TEMPLATES[intent]
  const lines: string[] = [template.lead(ctx), '']

  lines.push('Please:')
  template.steps(ctx).forEach((step, i) => lines.push(`${i + 1}. ${step}`))

  if (withContext) {
    lines.push('', 'Details:', '"""', text, '"""')
  } else if (ask && intent !== 'general' && intent !== 'draft' && intent !== 'explain') {
    lines.push('', `Context: ${ask}.`)
  }

  lines.push(
    '',
    'Keep the answer concise and practical. If something essential is missing, say what it is instead of guessing.',
  )

  return { text: lines.join('\n'), intent, note: template.note }
}
