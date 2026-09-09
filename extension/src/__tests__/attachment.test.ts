// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  DOCX_FIXTURE_FACTS,
  XLSX_FIXTURE_FACTS,
  buildRichDocx,
  buildRichXlsx,
} from '@/files/__tests__/buildFixtures'
import { extractFile } from '@/files/extract'
import { reviewAttachment } from '../attachment'
import { MAX_ATTACHMENT_BYTES, fromBase64, toBase64 } from '../bytes'

/**
 * Reading an attachment, end to end.
 *
 * The point of this suite is the round trip, not the parsing: a Word document
 * goes in as base64, comes back judged, is asked to be rewritten, and the
 * rewritten bytes are re-opened and re-scanned to prove the values are
 * actually gone. A finding that is shown and then survives cleaning is worse
 * than one that was never found, and for a binary format there are three
 * places that can go wrong rather than one.
 */

describe('base64 transport', () => {
  it('round-trips bytes exactly', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255, 65, 0, 254])
    const back = new Uint8Array(fromBase64(toBase64(original.buffer)))
    expect(Array.from(back)).toEqual(Array.from(original))
  })

  it('handles a buffer far larger than the call-stack limit', () => {
    // `String.fromCharCode(...bytes)` with a spread of a multi-megabyte array
    // throws RangeError, and it would throw at attach time on exactly the
    // large files most worth checking. Hence the chunking.
    const big = new Uint8Array(2_000_000)
    for (let i = 0; i < big.length; i++) big[i] = i % 256
    const encoded = toBase64(big.buffer)
    const back = new Uint8Array(fromBase64(encoded))
    expect(back.length).toBe(big.length)
    expect(back[0]).toBe(0)
    expect(back[1_999_999]).toBe(1_999_999 % 256)
  })

  it('caps well under what a tab can hold three times over', () => {
    // The encoded string, the decoded copy and the parsed document all coexist.
    expect(MAX_ATTACHMENT_BYTES).toBeLessThanOrEqual(20_000_000)
  })
})

describe('a Word document', () => {
  it('is judged by the same engine as a pasted prompt', async () => {
    const bytes = toBase64(await buildRichDocx())
    const response = await reviewAttachment({
      type: 'attachment',
      name: 'incident-report.docx',
      bytes,
      host: 'chatgpt.com',
    })

    expect(response.unreadable).toBeUndefined()
    expect(response.decision).not.toBe('allow')
    // Names the file: "check this before sending" is useless when the thing
    // being sent is an attachment the user may have forgotten they attached.
    expect(response.headline).toContain('incident-report.docx')

    const values = response.findings.map((f) => f.value)
    expect(values).toContain(DOCX_FIXTURE_FACTS.email)
  })

  it('comes back rewritten, and the values are really gone', async () => {
    const bytes = toBase64(await buildRichDocx())
    const response = await reviewAttachment({
      type: 'attachment',
      name: 'incident-report.docx',
      bytes,
      host: 'chatgpt.com',
      mode: 'redact',
    })

    expect(response.cleaned).toBeDefined()
    if (!response.cleaned) return

    // Re-open the rewritten document and read it back. Three things have to
    // have worked — extraction, the rewrite, and the transport — and only
    // this proves all three.
    const reopened = await extractFile(
      new File([fromBase64(response.cleaned.bytes)], response.cleaned.name),
    )
    for (const secret of [
      DOCX_FIXTURE_FACTS.email,
      DOCX_FIXTURE_FACTS.phone,
      DOCX_FIXTURE_FACTS.footerEmail,
      DOCX_FIXTURE_FACTS.tableEmail,
    ]) {
      expect(reopened.text).not.toContain(secret)
    }
    // Headers and footers too, not only the body.
    expect(reopened.text).not.toContain(DOCX_FIXTURE_FACTS.footerName)
  })
})

describe('a spreadsheet', () => {
  it('is read across sheets and rewritten', async () => {
    const bytes = toBase64(buildRichXlsx())
    const response = await reviewAttachment({
      type: 'attachment',
      name: 'customer-contacts.xlsx',
      bytes,
      host: 'chatgpt.com',
      mode: 'redact',
    })

    expect(response.unreadable).toBeUndefined()
    expect(response.decision).not.toBe('allow')
    expect(response.cleaned).toBeDefined()
    if (!response.cleaned) return

    const reopened = await extractFile(
      new File([fromBase64(response.cleaned.bytes)], response.cleaned.name),
    )
    expect(reopened.text).not.toContain(XLSX_FIXTURE_FACTS.email)
    expect(reopened.text).not.toContain(XLSX_FIXTURE_FACTS.phone)
    // Structure survives: the second sheet is still there to be read.
    expect(reopened.sheetNames).toContain(XLSX_FIXTURE_FACTS.secondSheetName)
  })
})

describe('when it cannot be read', () => {
  it('warns rather than reporting clean', async () => {
    const response = await reviewAttachment({
      type: 'attachment',
      name: 'holiday.jpg',
      bytes: toBase64(new Uint8Array([1, 2, 3]).buffer),
      host: 'chatgpt.com',
    })

    // The whole rule: "we could not read it" is not "there is nothing in it",
    // and collapsing the two is how a safety tool ends up protecting nothing.
    expect(response.decision).toBe('warn')
    expect(response.unreadable).toBeTruthy()
    expect(response.findings).toHaveLength(0)
  })

  it('warns on a corrupt document of a supported type', async () => {
    const response = await reviewAttachment({
      type: 'attachment',
      name: 'broken.docx',
      bytes: toBase64(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]).buffer),
      host: 'chatgpt.com',
    })

    expect(response.decision).toBe('warn')
    expect(response.unreadable).toBeTruthy()
  })
})
