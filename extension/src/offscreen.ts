import { registerLocalModel } from '@/engine/confirm'
import { createGlinerConfirmer } from '@/engine/confirm/gliner'
import { runtime } from './browser'
import { APP_ORIGIN } from './config'
import { installAllowlist } from './allowlist'
import { reviewAttachment } from './attachment'
import { confirmedFindings, runDeepCheck } from './deep'
import type { AttachmentRequest, AttachmentResponse, DeepCheckResponse } from './protocol'
import type { Finding } from '@/engine/types'

/** Substituted by `build.mjs`; see the note beside the `console.info` below. */
declare const __BUILD_STAMP__: string

/**
 * Stage two's host — where GLiNER runs.
 *
 * ## Why this page exists
 *
 * A model cannot live in an MV3 service worker: the worker is killed after
 * roughly thirty seconds idle, so 183 MB of weights would be evicted and
 * reloaded between one prompt and the next, turning a one-off cost into a
 * recurring one. An offscreen document is the primitive MV3 provides for
 * exactly this — a real page, in the extension's own origin, with a DOM and
 * WebAssembly, that outlives the worker.
 *
 * Nothing is rendered here. It is somewhere for weights to sit.
 *
 * ## What comes from where
 *
 * | | |
 * | --- | --- |
 * | ONNX runtime JS | bundled — 530 KB minified, one backend only |
 * | `ort-wasm-simd-threaded.wasm` | bundled — 9.5 MB, served from this origin |
 * | GLiNER weights, 183 MB | fetched from the app's origin, then cached |
 *
 * Only the weights are fetched, and only from the origin that provisioned
 * them — never from a CDN or from HuggingFace at scan time. They are cached
 * after the first successful load, so the second prompt onwards works with the
 * app closed.
 *
 * ## When it cannot run
 *
 * If the weights are unreachable — the app was never started, or never
 * provisioned — the engine falls back to its deterministic deep-context
 * confirmer, which needs no files and cannot fail. Stage two therefore always
 * happens, and `confirmedBy` reports which one answered, so a degraded run is
 * visible rather than silent.
 */

registerLocalModel(
  createGlinerConfirmer({
    // Weights and tokenizer from the app's origin, which provisioned them.
    basePath: `${APP_ORIGIN}/models/`,
    modelName: 'gliner-small',
    modelFile: `${APP_ORIGIN}/models/gliner-small/onnx/model.onnx`,
    // The runtime, however, ships with the extension. Loading executable code
    // over the network would defeat the point of the CSP, and MV3 forbids it
    // regardless.
    wasmPaths: runtime.runtime.getURL('wasm/'),
    /**
     * WASM, stated rather than detected.
     *
     * `build.mjs` aliases the two GPU backends to a throwing stub and ships
     * the WASM-only runtime — 16 kB instead of 44 MB. Feature-detecting on
     * `navigator.gpu`, which exists in an offscreen document, therefore asked
     * for a backend that had been deliberately removed: session construction
     * threw, the confirmer caught it, and every escalation in this extension
     * silently fell back to deep-context. The model had never once run here.
     *
     * The host knows what the host bundled. Nothing inside the confirmer can.
     */
    executionProvider: 'wasm',
    /**
     * Single-threaded, unconditionally.
     *
     * Not a performance preference — threading cannot work here. ORT's
     * threaded build spawns its workers from `blob:` URLs, and the MV3
     * content security policy for extension pages is
     * `script-src 'self' 'wasm-unsafe-eval'`, which does not allow them and
     * which MV3 will not let an extension widen.
     *
     * Cross-origin isolation is therefore necessary and not sufficient, and
     * chasing it here actively hurt: declaring COEP made
     * `crossOriginIsolated` true, which switched threading *on*, which
     * produced a run of `importScripts` failures followed by inference
     * throwing `Cannot convert 1 to a BigInt`. The runtime half-started with
     * dead workers instead of failing cleanly.
     *
     * The app is a different context with an ordinary CSP, and threads there.
     */
    multiThread: false,
  }),
)

// Attachments are scanned here, so this context needs the allowlist too — a
// document full of the user's own signature should be no noisier than a prompt.
void installAllowlist()

export interface OffscreenDeepRequest {
  type: 'offscreen-deep-check'
  text: string
}

/**
 * An attachment to read.
 *
 * Relayed here rather than handled in the worker because the parsers live
 * here — see `attachment.ts` for the 3.2 MB measurement that decided it.
 */
export interface OffscreenAttachmentRequest {
  type: 'offscreen-attachment'
  request: AttachmentRequest
}

runtime.runtime.onMessage.addListener(
  (
    message: OffscreenAttachmentRequest,
    _sender,
    sendResponse: (r: AttachmentResponse) => void,
  ) => {
    if (message?.type !== 'offscreen-attachment') return false

    reviewAttachment(message.request).then(sendResponse, (cause) =>
      sendResponse({
        type: 'attachment-checked',
        decision: 'warn',
        headline: `Could not check ${message.request.name}`,
        summary: '',
        findings: [],
        ms: 0,
        unreadable:
          cause instanceof Error ? cause.message : 'that file could not be read',
      }),
    )

    // Held open: parsing a spreadsheet takes far longer than the synchronous
    // reply Chrome would otherwise expect.
    return true
  },
)

/**
 * Findings for the rewrite, decided here rather than in the worker.
 *
 * The worker can run an escalation, but `registerLocalModel` is called in
 * this file and nowhere else, so what answers there is the deterministic
 * confirmer. The banner was relayed here and the cleaning was not, which is
 * how "Closer look caught 2 more" appeared above a rewrite that masked none
 * of them: two contexts, two different answers about the same text.
 *
 * Full `Finding` objects, not the `WireFinding` shape the banner uses —
 * offsets are what a rewrite needs, and the display shape has none.
 */
export interface OffscreenConfirmRequest {
  type: 'offscreen-confirm'
  text: string
}

export interface OffscreenConfirmResponse {
  type: 'confirmed-findings'
  findings: Finding[]
}

runtime.runtime.onMessage.addListener(
  (
    message: OffscreenConfirmRequest,
    _sender,
    sendResponse: (r: OffscreenConfirmResponse | null) => void,
  ) => {
    if (message?.type !== 'offscreen-confirm') return false

    confirmedFindings(message.text).then(
      (findings) => sendResponse({ type: 'confirmed-findings', findings }),
      // Null rather than an empty list: the worker has to be able to tell
      // "the model found nothing" from "this never ran", and answering with
      // no findings would silently clean less than stage one already had.
      () => sendResponse(null),
    )

    return true
  },
)

runtime.runtime.onMessage.addListener(
  (
    message: OffscreenDeepRequest,
    _sender,
    sendResponse: (r: DeepCheckResponse) => void,
  ) => {
    // Not ours. Returning false lets the worker's own listener answer instead.
    if (message?.type !== 'offscreen-deep-check') return false

    runDeepCheck(message.text).then(sendResponse, (cause) =>
      sendResponse({
        type: 'deep-checked',
        decision: 'warn',
        headline: '',
        summary: '',
        findings: [],
        withdrawn: 0,
        added: 0,
        ms: 0,
        unavailable:
          cause instanceof Error ? cause.message : 'the closer look failed',
      }),
    )

    // Held open until the promise settles: a cold model load takes far longer
    // than the synchronous reply Chrome would otherwise expect.
    return true
  },
)

/**
 * Last line in the file, and that is the whole point.
 *
 * An offscreen document created by an earlier load survives a rebuild:
 * `hasDocument()` reports it as present, so Chrome will not replace it with
 * new code, and a stale document is indistinguishable from a fixed one that
 * still fails. So the page has to say which build it is.
 *
 * It says it *here*, after both listeners are attached, because the first
 * version of this line said it first and read the build off
 * `runtime.getManifest()`. Chrome exposes only the messaging slice of
 * `chrome.runtime` to an offscreen context — `getURL` is always-available and
 * worked, `getManifest` is not and threw — so the diagnostic took both
 * `addListener` calls down with it. The page loaded, registered nothing, and
 * every deep check timed out into "closer look unavailable": the exact
 * silence this line exists to rule out.
 *
 * Printed last, it is a stronger signal than it was: not "the module
 * started", but "this page is listening, and it is this build".
 */
console.info(`[ai-safe] offscreen ready — ${__BUILD_STAMP__}`)
