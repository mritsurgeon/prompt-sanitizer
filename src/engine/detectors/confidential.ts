import type { Detector } from '../types'
import { runRules, type PatternRule } from './patterns'

/**
 * Layer 3b — company-confidential spans.
 *
 * This is a different question from "is this PII?". Nothing here identifies a
 * person; it identifies information that should stay inside the company.
 *
 * Kept deliberately narrow: only spans concrete enough to actually replace.
 * The broader judgement — "this whole document reads like a roadmap" — belongs
 * to the document sensitivity engine, which cannot be expressed as a span.
 */
export const CONFIDENTIAL_RULES: PatternRule[] = [
  {
    name: 'Internal project name',
    category: 'PROJECT_CODE',
    pattern:
      /\b(?:Project|Programme|Program|Initiative|Codename|Workstream)\s+([A-Z][A-Za-z0-9]{2,20})\b/g,
    valueGroup: 1,
    confidence: 0.8,
  },
  {
    name: 'Unreleased release date',
    category: 'RELEASE_PLAN',
    // A release verb, then a short gap, then a future-looking period. The
    // bounded lazy gap handles "ships in March 2027", "GA is targeted for
    // Q2 2027" and "launches H1 FY28" without enumerating every connective.
    pattern:
      /\b(?:GA|general availability|launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)|ship(?:s|ped|ping)?|beta|EAP|early access|tech preview|goes live|go live)\b[^.\n]{0,20}?\b(?:Q[1-4]\s*(?:FY)?\s*'?\d{2,4}|H[12]\s*(?:FY)?\s*'?\d{2,4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/gi,
    confidence: 0.75,
  },
  {
    name: 'Internal beta timing',
    category: 'RELEASE_PLAN',
    pattern:
      /\b(?:internal|private|closed|limited)\s+(?:beta|preview|release|rollout)\s+(?:begins|starts|opens|launches|is planned for|is scheduled for)\s+(?:in\s+)?(?:[A-Z][a-z]+|Q[1-4]|H[12])\b/gi,
    confidence: 0.78,
  },
  {
    name: 'Commercial discount or margin',
    category: 'PRICING_TERM',
    pattern:
      /\b\d{1,2}(?:\.\d)?\s?%\s*(?:discount|margin|uplift|commission|rebate|increase|reduction)\b/gi,
    confidence: 0.78,
  },
  {
    name: 'Priced commercial term',
    category: 'PRICING_TERM',
    pattern:
      /\b(?:discount|margin|list price|price|pricing|rate|uplift|quota|budget|contract value|deal value|cost)\b[^.\n]{0,24}?(?:R|ZAR|\$|US\$|USD|€|EUR|£|GBP)\s?\d[\d ,]*(?:\.\d+)?\s?(?:m|k|bn|million|thousand|billion)?/gi,
    confidence: 0.72,
  },
]

export const confidentialDetector: Detector = {
  id: 'confidential',
  layer: 'confidential',
  run: (text) => runRules(text, CONFIDENTIAL_RULES, 'confidential'),
}
