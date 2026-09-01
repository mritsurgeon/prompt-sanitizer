import { registerLocalModel } from '@/engine/confirm'
import { createGlinerConfirmer } from '@/engine/confirm/gliner'
import { runtime } from './browser'
import { APP_ORIGIN } from './config'
import { runDeepCheck } from './deep'
import type { DeepCheckResponse } from './protocol'

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
  }),
)

export interface OffscreenDeepRequest {
  type: 'offscreen-deep-check'
  text: string
}

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
