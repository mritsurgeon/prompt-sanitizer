/**
 * Stands in for the ONNX runtime backends we never use.
 *
 * `gliner` statically imports all three — `onnxruntime-web`,
 * `onnxruntime-web/webgpu` and `onnxruntime-web/webgl` — at module top, so a
 * bundler has no way to drop the unused two. That is where the extension's
 * 44 MB came from, and it was 44 MB of code that could never execute: an
 * offscreen document has no WebGPU adapter and no WebGL context worth using,
 * so the confirmer pins `executionProvider: 'wasm'` and only the CPU backend
 * is ever constructed.
 *
 * Aliased in `build.mjs`. The shape only has to survive being read at import
 * time — `gliner` touches `env.wasm.wasmPaths` on whichever backend it selects,
 * and it never selects these.
 */

const unavailable = () => {
  throw new Error(
    'This ONNX backend is not bundled in the extension. The confirmer runs on ' +
      'the WASM backend; reaching here means executionProvider was changed.',
  )
}

export default {
  env: { wasm: { wasmPaths: '', wasmBinary: undefined, numThreads: 1 } },
  get InferenceSession() {
    return unavailable()
  },
  get Tensor() {
    return unavailable()
  },
}
