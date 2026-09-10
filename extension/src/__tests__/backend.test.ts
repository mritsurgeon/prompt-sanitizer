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

describe('threads are declared, not assumed', () => {
  const build = read('../../build.mjs')
  const offscreen = read('../offscreen.ts')
  const vite = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8')
  const gliner = readFileSync(
    new URL('../../../src/engine/confirm/gliner.ts', import.meta.url),
    'utf8',
  )

  it('lets the host decide, rather than hardcoding threads on', () => {
    // `multiThread: true` hardcoded is what made a context that cannot thread
    // fail instead of simply running slower.
    expect(gliner).toMatch(/multiThread:\s*threaded/)
    expect(gliner).toMatch(/config\.multiThread \?\? isIsolated\(\)/)
  })

  it('runs the offscreen document single-threaded, whatever isolation says', () => {
    // ORT spawns worker threads from `blob:` URLs and the MV3 CSP is
    // `script-src 'self' 'wasm-unsafe-eval'`, which does not permit them and
    // cannot be widened. Isolation is necessary and not sufficient, so the
    // offscreen document must state this rather than infer it.
    expect(offscreen).toMatch(/multiThread:\s*false/)
  })

  it('does not declare isolation it cannot use', () => {
    // Declaring COEP made `crossOriginIsolated` true, which switched threading
    // on so that it could fail — `importScripts` errors, then inference
    // throwing `Cannot convert 1 to a BigInt`. It also made every cross-origin
    // fetch need CORP, which is a deployment constraint bought for nothing.
    expect(build).not.toMatch(/cross_origin_embedder_policy:\s*\{/)
  })

  it('still isolates the app, where threading does work', () => {
    // An ordinary page's CSP permits blob workers, so the app threads and the
    // extension does not. Same code, different context.
    expect(vite).toContain('Cross-Origin-Embedder-Policy')
    // `server` is dev only; the built app needs it too.
    expect(vite).toMatch(/preview:\s*\{\s*headers/)
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

describe('the offscreen document only touches APIs it has', () => {
  const offscreen = read('../offscreen.ts')
  const build = read('../../build.mjs')

  /**
   * Chrome gives an offscreen document the messaging slice of `chrome.runtime`
   * and little else. The trap is that the slice is not obviously a slice:
   * `getURL` works there, so the object looks like the full `chrome.runtime`
   * until something reaches past the edge.
   *
   * `getManifest` is past the edge. A build stamp read from it threw at module
   * top level and took both `onMessage.addListener` calls with it, so the page
   * loaded, registered no listener, and every deep check timed out into
   * "closer look unavailable" — the model never ran, and nothing said so.
   */
  const AVAILABLE = new Set([
    'getURL',
    'onMessage',
    'sendMessage',
    'connect',
    'id',
    'lastError',
  ])

  it('never reaches past the messaging slice', () => {
    const used = [...offscreen.matchAll(/\bruntime\.runtime\.(\w+)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter((name) => !AVAILABLE.has(name))).toEqual([])
  })

  it('takes its build stamp from the build, not from the manifest', () => {
    expect(offscreen).toContain('__BUILD_STAMP__')
    // The `declare` alone compiles happily and is `undefined` at runtime, so
    // the substitution has to be checked at the other end too.
    expect(build).toMatch(/define:\s*\{\s*__BUILD_STAMP__:/)
  })

  it('says it is ready only once it is listening', () => {
    // Printed before the listeners, the line proves the module started.
    // Printed after them, it proves the page can actually answer — which is
    // the question being asked when somebody goes looking for it.
    const ready = offscreen.lastIndexOf('offscreen ready')
    const listening = offscreen.lastIndexOf('onMessage.addListener')
    expect(ready).toBeGreaterThan(listening)
  })
})
