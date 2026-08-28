import type { Candidate, CategoryId, Detector, DetectorLayer } from '../types'

/**
 * Layer 1 — deterministic pattern matching.
 *
 * Fast, explainable, no model required. Each rule can optionally validate a
 * candidate match (Luhn, octet ranges, digit counts) to keep false positives
 * down, and can point at a capture group so that `password: hunter2` only
 * flags `hunter2` and keeps the label intact.
 */

export interface PatternRule {
  /** Human-readable name shown in "View details". */
  name: string
  category: CategoryId
  pattern: RegExp
  /** Which capture group holds the sensitive value (0 = whole match). */
  valueGroup?: number
  confidence: number
  /** Return false to reject a candidate match. */
  validate?: (value: string, match: RegExpExecArray, text: string) => boolean
  /**
   * Drop trailing sentence punctuation from the match. Used where a greedy
   * character class would otherwise swallow the full stop after a URL or path.
   */
  trimTrailingPunctuation?: boolean
}

const luhn = (digits: string): boolean => {
  const d = digits.replace(/\D/g, '')
  if (d.length < 12) return false
  let sum = 0
  let double = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (double) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    double = !double
  }
  return sum % 10 === 0
}

const digitCount = (s: string) => (s.match(/\d/g) ?? []).length

/** Reject a "phone number" that is really a date, a version or an amount. */
const looksLikePhone = (value: string, match: RegExpExecArray, text: string) => {
  const digits = digitCount(value)
  if (digits < 9 || digits > 15) return false
  // Dates and timestamps, not phone numbers.
  if (/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(value)) return false
  // Dotted version and build numbers: "12.1.0.2131", "9.0.0.1420".
  if (/^\d+(?:\.\d+){2,}$/.test(value.trim())) return false
  const before = text[match.index - 1] ?? ' '
  const after = text[match.index + value.length] ?? ' '
  if (/[A-Za-z0-9._/@:$£€¥-]/.test(before)) return false
  // A trailing full stop is just the end of a sentence; "192.168" is not.
  if (/[A-Za-z/@:-]/.test(after)) return false
  if (after === '.' && /^\.\d/.test(text.slice(match.index + value.length)))
    return false
  // Require some structure: a country code, separators, or a plausible length.
  return /^\+/.test(value.trim()) || /[\s().-]/.test(value) || digits >= 10
}

export const PATTERN_RULES: PatternRule[] = [
  // ---- secrets (highest value, matched first) ----------------------------
  {
    name: 'PEM private key block',
    category: 'PRIVATE_KEY',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    confidence: 1,
  },
  {
    name: 'AWS access key ID',
    category: 'API_KEY',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    confidence: 0.99,
  },
  {
    name: 'GitHub token',
    category: 'ACCESS_TOKEN',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    confidence: 0.99,
  },
  {
    name: 'Slack token',
    category: 'ACCESS_TOKEN',
    pattern: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g,
    confidence: 0.98,
  },
  {
    name: 'Google API key',
    category: 'API_KEY',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    confidence: 0.98,
  },
  {
    name: 'Stripe key',
    category: 'API_KEY',
    pattern: /\b[srp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    confidence: 0.98,
  },
  {
    name: 'Model provider key',
    category: 'API_KEY',
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
    confidence: 0.97,
  },
  {
    name: 'JSON web token',
    category: 'ACCESS_TOKEN',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    confidence: 0.97,
  },
  {
    name: 'Bearer authorization header',
    category: 'ACCESS_TOKEN',
    pattern: /\bBearer\s+([A-Za-z0-9_\-.=+/]{16,})/gi,
    valueGroup: 1,
    confidence: 0.9,
  },
  {
    name: 'Database connection string',
    category: 'CONNECTION_STRING',
    pattern:
      /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|amqps?|mssql|jdbc:[a-z]+):\/\/[^\s"'<>]+/gi,
    confidence: 0.95,
  },
  {
    name: 'ODBC style connection string',
    category: 'CONNECTION_STRING',
    pattern:
      /\b(?:Server|Data Source)\s*=\s*[^;\n]{2,}?;[^\n]*?(?:Password|Pwd)\s*=\s*[^;\n]+/gi,
    confidence: 0.95,
  },
  {
    name: 'Password assignment',
    category: 'PASSWORD',
    pattern:
      /\b(?:password|passwd|pwd|passphrase|pass)\s*(?:is|:|=|=>)\s*(?:"([^"\n]{3,64})"|'([^'\n]{3,64})'|([^\s"'<>,;]{3,64}))/gi,
    valueGroup: -1,
    confidence: 0.93,
  },
  {
    name: 'Secret or key assignment',
    category: 'API_KEY',
    pattern:
      /\b(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?token|app[_-]?secret|token)\s*(?:is|:|=|=>)\s*(?:"([^"\n]{6,120})"|'([^'\n]{6,120})'|([A-Za-z0-9_\-.=+/]{8,120}))/gi,
    valueGroup: -1,
    confidence: 0.92,
  },

  // ---- structured personal data ------------------------------------------
  {
    name: 'Payment card number (Luhn checked)',
    category: 'CREDIT_CARD',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    confidence: 0.95,
    validate: (v) => {
      const d = v.replace(/\D/g, '')
      return d.length >= 13 && d.length <= 19 && luhn(d)
    },
  },
  {
    name: 'IBAN',
    category: 'BANK_ACCOUNT',
    pattern: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g,
    confidence: 0.9,
    validate: (v) => v.replace(/\s/g, '').length >= 15,
  },
  {
    name: 'Email address',
    category: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
    confidence: 0.99,
  },
  {
    name: 'US social security number',
    category: 'NATIONAL_ID',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: 0.9,
  },
  {
    name: 'National ID number (13 digit, checksum)',
    category: 'NATIONAL_ID',
    pattern: /\b\d{13}\b/g,
    confidence: 0.85,
    validate: (v) => luhn(v),
  },
  {
    name: 'Phone number',
    category: 'PHONE',
    // Spaces and tabs only — never a line break. A phone number does not span
    // two lines, but a table of build numbers will happily let a greedy match
    // join "12.1.0.2131" to the next row's "2" and reach nine digits.
    pattern: /\+?\d[\d \t().-]{7,18}\d/g,
    confidence: 0.85,
    validate: looksLikePhone,
  },

  // ---- network / system ---------------------------------------------------
  {
    name: 'IPv4 address',
    category: 'IP_ADDRESS',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    confidence: 0.97,
    validate: (v, match, text) => {
      if (!v.split('.').every((o) => Number(o) <= 255)) return false
      // "version 12.1.2.4" is a release number, not a host.
      const before = text.slice(Math.max(0, match.index - 14), match.index)
      return !/\b(?:version|v|rel|release|build|patch)\.?\s*$/i.test(before)
    },
  },
  {
    name: 'IPv6 address',
    category: 'IP_ADDRESS',
    pattern: /\b(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}\b/g,
    confidence: 0.9,
  },
  {
    name: 'MAC address',
    category: 'MAC_ADDRESS',
    pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,
    confidence: 0.95,
  },
  {
    name: 'UUID / GUID',
    category: 'UUID',
    pattern:
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    confidence: 0.98,
  },
  {
    name: 'Web link',
    category: 'URL',
    pattern: /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi,
    confidence: 0.95,
    trimTrailingPunctuation: true,
  },
]

const clone = (re: RegExp) => new RegExp(re.source, re.flags)

/**
 * Shared rule runner used by the pattern layer and the business-rule layer.
 * Kept generic so new rule packs only need data, not code.
 */
export function runRules(
  text: string,
  rules: PatternRule[],
  layer: DetectorLayer,
): Candidate[] {
  const out: Candidate[] = []

  for (const rule of rules) {
    const re = clone(rule.pattern)
    let match: RegExpExecArray | null

    while ((match = re.exec(text)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex++
        continue
      }

      // valueGroup -1 means "first capture group that actually matched".
      let value = match[0]
      let offset = 0

      if (rule.valueGroup !== undefined) {
        const groupIndex =
          rule.valueGroup === -1
            ? match.findIndex((g, i) => i > 0 && g !== undefined)
            : rule.valueGroup

        if (groupIndex > 0 && match[groupIndex] !== undefined) {
          value = match[groupIndex]
          offset = match[0].lastIndexOf(value)
          if (offset < 0) offset = 0
        }
      }

      if (rule.trimTrailingPunctuation) {
        const trimmed = value.replace(/[.,;:!?]+$/, '')
        if (trimmed.length > 0) value = trimmed
      }

      const start = match.index + offset
      if (rule.validate && !rule.validate(value, match, text)) continue

      out.push({
        category: rule.category,
        value,
        start,
        end: start + value.length,
        base: rule.confidence,
        layer,
        rule: rule.name,
      })
    }
  }

  return out
}

export const patternDetector: Detector = {
  id: 'patterns',
  layer: 'pattern',
  run: (text) => runRules(text, PATTERN_RULES, 'pattern'),
}
