import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The bundle and the request have to agree.
 *
 * `build.mjs` aliases the two GPU ONNX backends to a throwing stub and ships
 * the WASM-only runtime — 16 kB instead of 44 MB, and 44 MB of code that could
 * never run here anyway. The confirmer then feature-detected `navigator.gpu`,
 * which exists in an offscreen document, and asked for WebGPU: session
 * construction threw, the confirmer caught it and degraded, and **every
 * escalation in the extension silently used deep-context instead of the
 * model**. The comment in `ort-stub.ts` even asserted the confirmer pinned
 * WASM. It did not.
 *
 * Nothing inside the engine can see what a host bundled, so no amount of care
 * in `gliner.ts` prevents this. What prevents it is checking that the two
 * halves still say the same thing — which is what this file does, by reading
 * both and comparing.
 *
 * A source-level assertion is an unusual shape for a test. It earns its place
 * because the failure it catches is invisible at runtime: everything keeps
 * working, just worse, and the only symptom is findings quietly going missing.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('the offscreen document asks for a backend it has', () => {
  const build = read('../../build.mjs')
  const offscreen = read('../offscreen.ts')

  it('aliases the GPU backends away', () => {
    // If this stops being true the pin below is merely unnecessary, not wrong
    // — but the reason for it will have gone, so it should be revisited.
    expect(build).toContain("'onnxruntime-web/webgpu'")
    expect(build).toContain("'onnxruntime-web/webgl'")
    expect(build).toContain('ort-stub.ts')
  })

  it('states a provider rather than detecting one', () => {
    // Detection is right for the app, which bundles the whole runtime, and
    // wrong here. The host knows what the host shipped; the confirmer cannot.
    expect(offscreen).toMatch(/executionProvider:\s*'wasm'/)
  })

  it('never asks for a backend that was aliased away', () => {
    const requested = /executionProvider:\s*'(\w+)'/.exec(offscreen)?.[1]
    expect(requested).toBeDefined()
    for (const gpu of ['webgpu', 'webgl']) {
      if (build.includes(`'onnxruntime-web/${gpu}'`)) {
        expect(requested).not.toBe(gpu)
      }
    }
  })
})

describe('the confirmer reports which backend ran', () => {
  it('has a runtime getter, so the envelope can say more than "none"', async () => {
    const { createGlinerConfirmer } = await import('@/engine/confirm/gliner')
    const confirmer = createGlinerConfirmer({ executionProvider: 'wasm' })

    // This was never populated, so every envelope said `ep: 'none'` even while
    // the model was running — and `ep` exists precisely to answer whether
    // WebGPU earns its bundle size. Before load there is nothing to report,
    // which is honest; the point is that the field exists and is wired.
    expect(confirmer.runtime).toBeDefined()
    expect(confirmer.runtime?.ep).toBe('none')
    expect(confirmer.runtime?.labelCount).toBeGreaterThan(0)
  })
})
