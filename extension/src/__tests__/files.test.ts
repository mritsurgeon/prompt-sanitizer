// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ATTACHMENT_BYTES, toBase64 } from '../bytes'
import { installFileInterceptors, reviewFile, type FileGuardDeps } from '../files'
import type { AttachmentResponse, CheckResponse, SanitizeResponse } from '../protocol'

/**
 * Attachment interception.
 *
 * The hole this closes: everything else in the extension watches the composer,
 * and dragging a spreadsheet onto the same page went around all of it. A
 * `.docx` of case notes is a worse leak than any prompt somebody would type,
 * and it took one gesture.
 *
 * Two properties matter more than the rest. The replayed event must not be
 * intercepted again — the obvious implementation tags the *node* with a
 * property and then forgets to check it, which recurses forever. And a file
 * that cannot be read must be announced rather than passed in silence.
 */

const WARN: CheckResponse = {
  type: 'checked',
  decision: 'warn',
  headline: 'Check this before sending',
  summary: '1 email address',
  findings: [],
  ms: 0.2,
}

const BLOCK: CheckResponse = { ...WARN, decision: 'block', headline: 'Sensitive information' }
const ALLOW: CheckResponse = { ...WARN, decision: 'allow', headline: 'Nothing sensitive found' }

const CLEANED: SanitizeResponse = {
  type: 'sanitized',
  text: 'Contact [EMAIL] about the renewal',
  replaced: [],
  ms: 0.3,
}

const DIRTY_TEXT = 'Contact sarah.mitchell@example.com about the renewal'

interface Harness extends FileGuardDeps {
  presented: string[]
  warnings: string[]
  checked: string[]
  parsed: Array<{ name: string; mode?: string }>
}

function harness(
  response: CheckResponse | null,
  choice: 'clean' | 'anyway' | 'cancel' = 'clean',
  attachment?: AttachmentResponse | null,
): Harness {
  const presented: string[] = []
  const warnings: string[] = []
  const checked: string[] = []
  const parsed: Array<{ name: string; mode?: string }> = []
  return {
    presented,
    warnings,
    checked,
    parsed,
    check: async (text) => {
      checked.push(text)
      return response
    },
    clean: async () => CLEANED,
    parse: async (name, _bytes, mode) => {
      parsed.push({ name, mode })
      return attachment ?? null
    },
    present: async ({ file, allowAnyway }) => {
      presented.push(`${file.name}:${allowAnyway ? 'anyway' : 'no-anyway'}`)
      return choice
    },
    warn: (key) => void warnings.push(key),
  }
}

const textFile = (name = 'notes.txt', body = DIRTY_TEXT) =>
  new File([body], name, { type: 'text/plain' })

describe('deciding on one file', () => {
  it('lets a clean text file through without asking anybody', async () => {
    const deps = harness(ALLOW)
    expect(await reviewFile(textFile(), deps)).toEqual({ kind: 'allow' })
    expect(deps.presented).toHaveLength(0)
  })

  it('substitutes a cleaned copy under the same name', async () => {
    const deps = harness(WARN, 'clean')
    const verdict = await reviewFile(textFile('cases.csv'), deps)

    expect(verdict.kind).toBe('replace')
    if (verdict.kind !== 'replace') return
    // The user picked this file and should recognise what lands in the
    // conversation. The content is what changed, not the name.
    expect(verdict.file.name).toBe('cases.csv')
    expect(await verdict.file.text()).toBe(CLEANED.text)
    expect(deps.presented).toEqual(['cases.csv:anyway'])
  })

  it('honours send-anyway and cancel', async () => {
    expect(await reviewFile(textFile(), harness(WARN, 'anyway'))).toEqual({ kind: 'allow' })
    expect(await reviewFile(textFile(), harness(WARN, 'cancel'))).toEqual({ kind: 'cancel' })
  })

  it('offers no override on a block', async () => {
    const deps = harness(BLOCK, 'cancel')
    await reviewFile(textFile(), deps)
    expect(deps.presented).toEqual(['notes.txt:no-anyway'])
  })

  it('stays silent about formats the engine never claimed to read', async () => {
    const deps = harness(ALLOW)
    await reviewFile(new File(['bytes'], 'screenshot.png'), deps)
    // Warning about every image would be noise, and noise is how a safety
    // tool gets switched off.
    expect(deps.warnings).toHaveLength(0)
    expect(deps.checked).toHaveLength(0)
  })

  it('does not bother the worker with a trivial file', async () => {
    const deps = harness(ALLOW)
    await reviewFile(textFile('tiny.txt', 'ok'), deps)
    expect(deps.checked).toHaveLength(0)
  })

  it('says so when the worker does not answer', async () => {
    const deps = harness(null)
    expect(await reviewFile(textFile(), deps)).toEqual({ kind: 'allow' })
    expect(deps.warnings).toEqual(['file-no-worker'])
  })
})

describe('a document the offscreen reader handles', () => {
  const DOC_WARN: AttachmentResponse = {
    type: 'attachment-checked',
    decision: 'warn',
    headline: 'Check cases.xlsx before attaching it',
    summary: '3 email addresses',
    findings: [],
    ms: 12,
  }

  const docFile = (name = 'cases.xlsx', size = 2048) => {
    const file = new File([new Uint8Array(size)], name)
    return file
  }

  it('sends it to the reader rather than reading it here', async () => {
    const deps = harness(null, 'cancel', { ...DOC_WARN, decision: 'allow' })
    expect(await reviewFile(docFile(), deps)).toEqual({ kind: 'allow' })

    // The content script must not carry the parsers: pulling them in takes
    // the bundle from 17.7 KB to 3.2 MB, on every AI page load.
    expect(deps.parsed).toEqual([{ name: 'cases.xlsx', mode: undefined }])
    expect(deps.checked).toHaveLength(0)
    expect(deps.presented).toHaveLength(0)
  })

  it('asks for a rewrite only after the user chooses one', async () => {
    const cleanedBytes = toBase64(new Uint8Array([1, 2, 3]).buffer)
    const deps = harness(null, 'clean', {
      ...DOC_WARN,
      cleaned: { bytes: cleanedBytes, name: 'cases — sanitized.xlsx' },
    })

    const verdict = await reviewFile(docFile(), deps)

    expect(verdict.kind).toBe('replace')
    if (verdict.kind !== 'replace') return
    // The writer names the file, not us: a PDF comes back as .txt, and
    // handing back something claiming to still be a PDF would be a lie.
    expect(verdict.file.name).toBe('cases — sanitized.xlsx')
    // Twice, and only because the user asked — the common case moves the
    // bytes once.
    expect(deps.parsed.map((p) => p.mode)).toEqual([undefined, 'redact'])
  })

  it('withholds the file when the rewrite fails', async () => {
    const deps = harness(null, 'clean', DOC_WARN) // no `cleaned` in the reply
    expect(await reviewFile(docFile(), deps)).toEqual({ kind: 'cancel' })
    expect(deps.warnings).toContain('file-not-rewritten')
  })

  it('says so when the reader does not answer', async () => {
    const deps = harness(null, 'clean', null)
    expect(await reviewFile(docFile(), deps)).toEqual({ kind: 'allow' })
    expect(deps.warnings).toEqual(['file-no-reader'])
  })

  it('passes on the reason a document could not be read', async () => {
    const deps = harness(null, 'clean', {
      ...DOC_WARN,
      decision: 'warn',
      unreadable: 'that file could not be read',
    })
    expect(await reviewFile(docFile('broken.docx'), deps)).toEqual({ kind: 'allow' })
    expect(deps.warnings).toEqual(['file-unreadable-.docx'])
  })

  it('refuses to move a file too large to hold three times over', async () => {
    const deps = harness(null, 'clean', DOC_WARN)
    const huge = docFile('huge.xlsx', 8)
    Object.defineProperty(huge, 'size', { value: MAX_ATTACHMENT_BYTES + 1 })

    expect(await reviewFile(huge, deps)).toEqual({ kind: 'allow' })
    // Never sent: the encoded string, the decoded copy and the parsed
    // document would all coexist.
    expect(deps.parsed).toHaveLength(0)
    expect(deps.warnings).toEqual(['file-too-large'])
  })
})

describe('the DOM hooks', () => {
  let detach: (() => void) | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    detach?.()
    detach = null
  })

  const transfer = (...files: File[]) => {
    const dt = new DataTransfer()
    for (const file of files) dt.items.add(file)
    return dt
  }

  /**
   * happy-dom's `DragEvent` constructor does not keep `dataTransfer` from its
   * init dictionary, so it is defined on the instance — the same technique
   * `adapters.test.ts` uses for `target`. Chrome honours the constructor.
   */
  function dropOn(target: HTMLElement, ...files: File[]) {
    const event = new DragEvent('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer(...files) })
    target.dispatchEvent(event)
    return event
  }

  it('holds a drop and replays it exactly once', async () => {
    const zone = document.createElement('div')
    document.body.appendChild(zone)

    let delivered = 0
    zone.addEventListener('drop', () => {
      delivered += 1
    })

    detach = installFileInterceptors(harness(ALLOW))
    const event = dropOn(zone, textFile())

    // Held: once the page has the File it can upload it, and there is no
    // taking it back.
    expect(event.defaultPrevented).toBe(true)
    expect(delivered).toBe(0)

    await vi.waitFor(() => expect(delivered).toBe(1))
    // Exactly one. The replayed event carries a marker so our own handler
    // ignores it; without that this recurses forever.
    await new Promise((r) => setTimeout(r, 10))
    expect(delivered).toBe(1)
  })

  it('does not deliver a drop the user cancelled', async () => {
    const zone = document.createElement('div')
    document.body.appendChild(zone)
    let delivered = 0
    zone.addEventListener('drop', () => {
      delivered += 1
    })

    detach = installFileInterceptors(harness(WARN, 'cancel'))
    dropOn(zone, textFile())

    await new Promise((r) => setTimeout(r, 20))
    expect(delivered).toBe(0)
  })

  it('holds a file picker, swaps the file, and replays once', async () => {
    const input = document.createElement('input')
    input.type = 'file'
    document.body.appendChild(input)

    const seen: number[] = []
    input.addEventListener('change', () => {
      seen.push(input.files?.length ?? 0)
    })

    input.files = transfer(textFile('cases.csv')).files
    detach = installFileInterceptors(harness(WARN, 'clean'))

    input.dispatchEvent(new Event('change', { bubbles: true }))

    // `change` is not cancelable, so stopping propagation is the entire
    // mechanism — the site's own listener must not see the original.
    expect(seen).toHaveLength(0)

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(await input.files![0].text()).toBe(CLEANED.text)
    expect(input.files![0].name).toBe('cases.csv')
  })

  it('clears the input when nothing survives', async () => {
    const input = document.createElement('input')
    input.type = 'file'
    document.body.appendChild(input)
    input.files = transfer(textFile()).files

    detach = installFileInterceptors(harness(WARN, 'cancel'))
    input.dispatchEvent(new Event('change', { bubbles: true }))

    // Otherwise the page later finds a file the user chose to withhold.
    await vi.waitFor(() => expect(input.files?.length ?? 0).toBe(0))
  })

  it('ignores a change on anything that is not a file input', async () => {
    const text = document.createElement('input')
    text.type = 'text'
    text.value = DIRTY_TEXT
    document.body.appendChild(text)

    let saw = 0
    text.addEventListener('change', () => {
      saw += 1
    })

    const deps = harness(WARN)
    detach = installFileInterceptors(deps)
    text.dispatchEvent(new Event('change', { bubbles: true }))

    await new Promise((r) => setTimeout(r, 10))
    expect(saw).toBe(1)
    expect(deps.checked).toHaveLength(0)
  })
})
