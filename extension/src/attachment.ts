import { scan } from '@/engine/detect'
import { evaluate, getPolicy } from '@/engine/policy'
import { sanitize } from '@/engine/sanitize'
import { extractFile } from '@/files/extract'
import { buildCleanedFile } from '@/files/exportFile'
import { fromBase64, toBase64 } from './bytes'
import { toWire } from './deep'
import type { AttachmentRequest, AttachmentResponse } from './protocol'

/**
 * Reading an attachment, where the parsers are allowed to live.
 *
 * This runs in the offscreen document, and the reason is a measurement rather
 * than a preference. `src/files/extract.ts` lazily imports `xlsx`, `jszip` and
 * `pdfjs-dist`; a content script is injected as a classic script, so those
 * dynamic imports inline instead of splitting, and pulling this module into
 * the content bundle takes it from 17.7 KB to **3.2 MB** — parsed on every
 * ChatGPT, Claude, Gemini and Copilot page load, whether or not anybody ever
 * attaches anything.
 *
 * The offscreen document already carries weight for the model, is created on
 * demand rather than per page, and is a real ES module that code-splits. So
 * the whole job happens here — extract, scan, judge, and rewrite if asked —
 * and the content script keeps its rule: it reads the page, it asks, it
 * renders, and it decides nothing.
 *
 * The engine is imported, not reimplemented. A `.docx` attachment is scanned
 * by the same detectors, the same confidence model and the same policy as a
 * pasted prompt, so the two cannot disagree about the same content.
 */
export async function reviewAttachment(
  request: AttachmentRequest,
): Promise<AttachmentResponse> {
  const started = performance.now()

  const unreadable = (why: string): AttachmentResponse => ({
    type: 'attachment-checked',
    // Never `allow`: "we could not read it" is not "there is nothing in it",
    // and collapsing the two is how a safety tool ends up protecting nothing.
    decision: 'warn',
    headline: `Could not check ${request.name}`,
    summary: why,
    findings: [],
    ms: performance.now() - started,
    unreadable: why,
  })

  let extracted
  try {
    extracted = await extractFile(
      new File([fromBase64(request.bytes)], request.name),
    )
  } catch (cause) {
    return unreadable(
      cause instanceof Error ? cause.message : 'that file could not be read',
    )
  }

  const result = scan(extracted.text, {
    meta: { filename: extracted.name, sheetNames: extracted.sheetNames },
    structuralDelimiter: extracted.structuralDelimiter,
    phase: 'file',
  })
  const outcome = evaluate(result, getPolicy())

  const response: AttachmentResponse = {
    type: 'attachment-checked',
    decision: outcome.decision,
    headline:
      outcome.decision === 'block'
        ? `Sensitive information in ${extracted.name}`
        : outcome.decision === 'warn'
          ? `Check ${extracted.name} before attaching it`
          : `Nothing sensitive found in ${extracted.name}`,
    summary: outcome.summary,
    findings: outcome.drivers.map(toWire),
    ms: performance.now() - started,
  }

  if (!request.mode || outcome.decision === 'allow') return response

  // Rewriting, when asked. The same writer the app uses, so a cleaned
  // spreadsheet keeps its sheets, widths, formats and merges, and a cleaned
  // Word document keeps its runs byte-identical outside the replacements.
  try {
    const cleaned = sanitize(extracted.text, result.findings, {
      mode: request.mode,
    })
    const written = await buildCleanedFile(extracted, cleaned.text, cleaned.valueMap)
    return {
      ...response,
      ms: performance.now() - started,
      cleaned: {
        bytes: toBase64(await written.blob.arrayBuffer()),
        // The writer decides the name — a PDF becomes a `.txt`, because
        // rewriting PDF layout reliably is out of scope and handing back
        // something that claims to be a PDF would be a lie.
        name: written.filename,
      },
    }
  } catch (cause) {
    return {
      ...response,
      ms: performance.now() - started,
      unreadable:
        cause instanceof Error
          ? `that file could not be rewritten: ${cause.message}`
          : 'that file could not be rewritten',
    }
  }
}
