import { MAX_ATTACHMENT_BYTES, toBase64, fromBase64 } from './bytes'
import { listenFirst, markHandled } from './listen'
import type { AttachmentResponse, CheckResponse, SanitizeResponse } from './protocol'

/**
 * File attachments.
 *
 * The largest hole in the product until now: everything else on this page is
 * about the composer, and dragging a spreadsheet onto the same page bypassed
 * all of it. A `.docx` of case notes is a worse leak than any prompt somebody
 * would type, and it took one gesture.
 *
 * Two vectors, and nothing else: a drop, and a native file picker. Both are
 * taken at capture phase on `document`, for the same reason the send is — a
 * site that stops propagation on its own dropzone would otherwise hide the
 * attachment entirely.
 *
 * ## Where extraction happens, and why not here
 *
 * Not in this file. `src/files/extract.ts` lazily imports `xlsx`, `jszip` and
 * `pdfjs-dist`, and a content script is injected as a classic script, so those
 * dynamic imports get inlined rather than split. Measured: pulling
 * `extractFile` into the content bundle takes it from **17.7 KB to 3.2 MB** —
 * on every ChatGPT, Claude, Gemini and Copilot page load, whether or not
 * anybody ever attaches a file. That is exactly the kind of cost this project
 * refuses to put on the normal path.
 *
 * So this file reads what costs nothing to read — text, CSV, JSON, logs, via
 * `file.text()` — and hands Office and PDF documents to the offscreen
 * document, which already carries weight for the model, is created on demand
 * rather than per page, and is a real ES module that code-splits. The bytes
 * cross as base64 because MV3 messages are JSON.
 *
 * Either way the file is checked by the same engine as a pasted prompt, and
 * either way a file that could **not** be read is announced rather than passed
 * in silence: "we found nothing" and "we could not look" are different states,
 * and the second one is the user's to know about.
 */

/** Read directly, with no parser and no bundle cost. */
const TEXTUAL = new Set(['.txt', '.md', '.log', '.json', '.csv', '.tsv'])

/** Read by the offscreen document, which is where the parsers live. */
const PARSED = new Set(['.docx', '.xlsx', '.xlsm', '.pdf'])

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.')
  return at === -1 ? '' : name.slice(at).toLowerCase()
}

export type FileVerdict =
  | { kind: 'allow' }
  | { kind: 'replace'; file: File }
  | { kind: 'cancel' }

export interface FileGuardDeps {
  /** Ask the worker what it thinks of this text. */
  check(text: string): Promise<CheckResponse | null>
  /** Ask the worker to clean it. */
  clean(text: string, mode: 'redact' | 'pseudonymize'): Promise<SanitizeResponse | null>
  /**
   * Hand a document to the offscreen reader. `mode` asks for a rewrite as well
   * as a verdict, and is sent only after the user requests one — so the common
   * case moves the bytes once.
   */
  parse(
    name: string,
    bytes: string,
    mode?: 'redact' | 'pseudonymize',
  ): Promise<AttachmentResponse | null>
  /**
   * Put the decision in front of the user and resolve with what they chose.
   * Injected rather than imported so this module can be tested without a
   * shadow root, a worker or a banner.
   */
  present(options: {
    file: File
    response: CheckResponse
    allowAnyway: boolean
  }): Promise<'clean' | 'anyway' | 'cancel'>
  /** Say something is wrong, once per page, without content. */
  warn(key: string, message: string): void
}

/**
 * Events we dispatched ourselves.
 *
 * A `WeakSet` of the event objects rather than a property on the node: the
 * obvious version tags the target with an expando, which the page can read and
 * — more to the point — which the drafted version then never checked, so the
 * replayed event was intercepted again and the handler recursed forever.
 */
const ours = new WeakSet<Event>()

/** Decide on one file. Exported for tests; there is no other caller. */
export async function reviewFile(
  file: File,
  deps: FileGuardDeps,
): Promise<FileVerdict> {
  const extension = extensionOf(file.name)

  if (PARSED.has(extension)) return reviewDocument(file, deps)

  if (!TEXTUAL.has(extension)) {
    // Images, archives, anything else — the engine never claimed to read
    // these, and warning about every screenshot is noise. Noise is how a
    // safety tool gets switched off.
    return { kind: 'allow' }
  }

  let text: string
  try {
    text = await file.text()
  } catch {
    deps.warn(
      'file-unreadable',
      `an attachment could not be read, so it was NOT checked.`,
    )
    return { kind: 'allow' }
  }

  if (text.trim().length < 12) return { kind: 'allow' }

  const response = await deps.check(text)
  if (!response) {
    // The worker did not answer. Same rule as the send path: say so rather
    // than implying a clean result.
    deps.warn(
      'file-no-worker',
      `an attachment could not be checked because the local checker did not ` +
        `respond, and was NOT verified.`,
    )
    return { kind: 'allow' }
  }

  if (response.decision === 'allow') return { kind: 'allow' }

  const choice = await deps.present({
    file,
    response,
    allowAnyway: response.decision !== 'block',
  })

  if (choice === 'cancel') return { kind: 'cancel' }
  if (choice === 'anyway') return { kind: 'allow' }

  const cleaned = await deps.clean(text, 'redact')
  if (!cleaned) return { kind: 'cancel' }

  return {
    kind: 'replace',
    // Same name on purpose: the user picked this file and should recognise
    // what lands in the conversation. The content is what changed.
    file: new File([cleaned.text], file.name, {
      type: file.type || 'text/plain',
      lastModified: Date.now(),
    }),
  }
}

/**
 * A Word, Excel or PDF document, read by the offscreen document.
 *
 * The bytes cross twice in the worst case — once to judge, once more to
 * rewrite — and only ever a second time if the user asks for a clean copy.
 * That is the cheap trade against holding decoded state somewhere with an
 * eviction policy for a file the user is looking at right now.
 */
async function reviewDocument(
  file: File,
  deps: FileGuardDeps,
): Promise<FileVerdict> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    deps.warn(
      'file-too-large',
      `an attachment larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1e6)} MB ` +
        `was NOT checked — it would have to be copied through memory several ` +
        `times. Check it in the app instead.`,
    )
    return { kind: 'allow' }
  }

  let bytes: string
  try {
    bytes = toBase64(await file.arrayBuffer())
  } catch {
    deps.warn('file-unreadable', `an attachment could not be read, so it was NOT checked.`)
    return { kind: 'allow' }
  }

  const verdict = await deps.parse(file.name, bytes)
  if (!verdict) {
    deps.warn(
      'file-no-reader',
      `an attachment could not be checked because the reader did not respond, ` +
        `and was NOT verified.`,
    )
    return { kind: 'allow' }
  }

  if (verdict.unreadable) {
    // Read failed for a reason the reader could name. Say the reason.
    deps.warn(`file-unreadable-${extensionOf(file.name)}`, `${file.name} was NOT checked — ${verdict.unreadable}.`)
    return { kind: 'allow' }
  }

  if (verdict.decision === 'allow') return { kind: 'allow' }

  const choice = await deps.present({
    file,
    response: verdict as unknown as CheckResponse,
    allowAnyway: verdict.decision !== 'block',
  })

  if (choice === 'cancel') return { kind: 'cancel' }
  if (choice === 'anyway') return { kind: 'allow' }

  const rewritten = await deps.parse(file.name, bytes, 'redact')
  if (!rewritten?.cleaned) {
    deps.warn(
      'file-not-rewritten',
      `${file.name} could not be rewritten, so it was not attached. Clean it ` +
        `in the app instead.`,
    )
    return { kind: 'cancel' }
  }

  return {
    kind: 'replace',
    // The writer names the file, not us: a PDF comes back as `.txt`, because
    // rewriting PDF layout reliably is out of scope and handing back
    // something that claims to still be a PDF would be a lie.
    file: new File([fromBase64(rewritten.cleaned.bytes)], rewritten.cleaned.name, {
      lastModified: Date.now(),
    }),
  }
}

/** Run every file through review, preserving order. */
async function reviewAll(
  files: FileList,
  deps: FileGuardDeps,
): Promise<{ kept: File[]; cancelled: number }> {
  const kept: File[] = []
  let cancelled = 0
  for (const file of Array.from(files)) {
    const verdict = await reviewFile(file, deps)
    if (verdict.kind === 'cancel') cancelled += 1
    else kept.push(verdict.kind === 'replace' ? verdict.file : file)
  }
  return { kept, cancelled }
}

function transferOf(files: File[]): DataTransfer {
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  return transfer
}

/**
 * Attach the two hooks. Returns a detach function, which the tests use and
 * nothing else does.
 */
export function installFileInterceptors(deps: FileGuardDeps): () => void {
  const onDrop = (event: Event) => {
    if (ours.has(event)) return
    const drag = event as DragEvent
    const files = drag.dataTransfer?.files
    if (!files || files.length === 0) return

    // Hold the drop. Unlike a paste, there is no lenient option here: once the
    // page has the File it can upload it, and there is no taking it back.
    event.preventDefault()
    event.stopPropagation()

    // Duck-typed rather than `instanceof EventTarget`. A content script shares
    // the page's realm for its own document, but an event crossing a frame
    // boundary carries objects from another one, and `instanceof` is false
    // across realms — so the check would silently drop the replay for exactly
    // the drops that came from an embedded composer.
    const target = event.target as { dispatchEvent?: (e: Event) => boolean } | null
    void (async () => {
      try {
        const { kept } = await reviewAll(files, deps)
        if (!kept.length || typeof target?.dispatchEvent !== 'function') return

        const replay = new DragEvent('drop', {
          dataTransfer: transferOf(kept),
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: drag.clientX,
          clientY: drag.clientY,
        })
        ours.add(replay)
        markHandled(replay)
        target.dispatchEvent(replay)
      } catch (cause) {
        deps.warn(
          'file-drop-failed',
          `checking a dropped attachment failed, so it was not delivered. ` +
            `Please try again.`,
        )
        console.warn('[ai-safe] drop interception failed', cause)
      }
    })()
  }

  const onChange = (event: Event) => {
    if (ours.has(event)) return
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return
    const files = input.files
    if (!files || files.length === 0) return

    // `change` is not cancelable, so `preventDefault` would do nothing here —
    // stopping propagation is the entire mechanism, and it is load-bearing in
    // one direction only.
    event.stopImmediatePropagation()
    event.stopPropagation()

    void (async () => {
      try {
        const { kept } = await reviewAll(files, deps)
        if (!kept.length) {
          // Nothing survived. Clear the input so the page does not later find
          // a file the user chose to withhold.
          input.value = ''
          return
        }

        // Assigning `files` needs the native setter for the same reason
        // assigning `value` does on a React-controlled input: the framework
        // installs its own, and a direct assignment is swallowed.
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'files',
        )?.set
        if (setter) setter.call(input, transferOf(kept).files)

        const replay = new Event('change', { bubbles: true })
        ours.add(replay)
        markHandled(replay)
        input.dispatchEvent(replay)
      } catch (cause) {
        input.value = ''
        deps.warn(
          'file-input-failed',
          `checking an attachment failed, so it was not attached. Please try ` +
            `again.`,
        )
        console.warn('[ai-safe] file input interception failed', cause)
      }
    })()
  }

  // `window` and `document`, both at capture. A drop is the one event where
  // losing the race is unrecoverable: once the page holds the `File` it can
  // upload it, and nothing afterwards takes that back.
  const detach = [listenFirst('drop', onDrop), listenFirst('change', onChange)]

  return () => {
    for (const off of detach) off()
  }
}
