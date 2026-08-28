import type { Detector } from '../types'
import { hasInfraToken } from '../gazetteer'
import { runRules, type PatternRule } from './patterns'

/**
 * Layer 3 — business-sensitive patterns.
 *
 * Things that are not textbook PII but that you still would not want to hand
 * to an external AI tool: server naming, customer numbers, case references,
 * licence keys, internal project names.
 *
 * This list is intentionally plain data. To teach the scanner a new company
 * convention, add one entry — no other file needs to change.
 */
export const BUSINESS_RULES: PatternRule[] = [
  {
    name: 'Internal server or host name',
    category: 'INTERNAL_HOST',
    pattern: /\b[A-Za-z][A-Za-z0-9]{0,14}(?:-[A-Za-z0-9]{1,14}){1,3}\b/g,
    confidence: 0.86,
    validate: (v) => hasInfraToken(v) && /[A-Za-z]/.test(v),
  },
  {
    name: 'Internal domain name',
    category: 'INTERNAL_HOST',
    pattern:
      /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:local|internal|corp|lan|intra|intranet|priv|home)\b/gi,
    confidence: 0.92,
  },
  {
    name: 'Network share path',
    category: 'NETWORK_PATH',
    pattern: /\\\\[A-Za-z0-9._-]+(?:\\[A-Za-z0-9._$-]+)+/g,
    confidence: 0.94,
    trimTrailingPunctuation: true,
  },
  {
    name: 'Customer or account number',
    category: 'CUSTOMER_ID',
    pattern: /\b(?:CUST|CUSTOMER|ACCT|ACCOUNT|CLIENT|CLI)[-_ ]?#?\d{3,10}\b/gi,
    confidence: 0.93,
  },
  {
    name: 'Support case or ticket number',
    category: 'CASE_ID',
    pattern:
      /\b(?:CASE|TICKET|TKT|SR|INC|REQ|RITM|CHG|PRB|SUPPORT)[-_ ]?#?\d{3,10}\b/gi,
    confidence: 0.93,
  },
  {
    name: 'Contract, order or invoice number',
    category: 'CONTRACT_ID',
    pattern:
      /\b(?:CTR|CONTRACT|AGR|AGREEMENT|PO|SO|QUOTE|QT|INV|INVOICE|SUB|SUBSCRIPTION)[-_ ]?#?\d{3,10}\b/gi,
    confidence: 0.9,
  },
  {
    name: 'Employee number',
    category: 'EMPLOYEE_ID',
    pattern: /\b(?:EMP|EMPL|STAFF|EID|BADGE|PERSONNEL)[-_ ]?#?\d{3,10}\b/gi,
    confidence: 0.9,
  },
  {
    name: 'Licence or product key',
    category: 'LICENSE_KEY',
    pattern: /\b[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){3,5}\b/g,
    confidence: 0.88,
    validate: (v) => /\d/.test(v) && /[A-Z]/.test(v),
  },
  {
    name: 'Internal reference code',
    category: 'REFERENCE_ID',
    pattern: /\b[A-Z]{2,6}-\d{4,9}\b/g,
    confidence: 0.62,
  },
]

export const businessDetector: Detector = {
  id: 'business',
  layer: 'business',
  run: (text) => runRules(text, BUSINESS_RULES, 'business'),
}
