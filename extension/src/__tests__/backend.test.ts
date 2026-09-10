import { existsSync, readFileSync } from 'node:fs'
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

describe('the extension bundles the runtime gliner was written against', () => {
  const build = read('../../build.mjs')
  const root = new URL('../../../', import.meta.url)
  const json = (path: string) =>
    JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Record<string, never>

  /**
   * Two ONNX runtimes live in this tree and only one of them works.
   *
   * `@xenova/transformers` pins `onnxruntime-web@1.14.0` and npm hoists it;
   * `gliner` requires `1.19.2`, which stays nested. Nothing declares the
   * package directly, so `node_modules/onnxruntime-web` is transformers'
   * copy — and the build alias pointed at it, handing gliner a runtime five
   * minor versions older than the one it targets.
   *
   * They differ exactly where gliner touches. It builds int64 tensors from
   * plain number arrays, which 1.19 maps through `BigInt` and 1.14 does not:
   * `BigInt64Array.from([1, …])` throws `Cannot convert 1 to a BigInt`, and
   * every escalation fell back to the deterministic confirmer.
   *
   * Node and the dev server never reproduced it, because ordinary resolution
   * gives gliner its own copy. Only the alias overrode that, so the model
   * worked everywhere except the one place it was meant to run.
   */
  const required = (json('node_modules/gliner/package.json').dependencies as
    Record<string, string>)['onnxruntime-web']

  it('aliases onnxruntime-web to the copy gliner depends on', () => {
    expect(build).toContain("join(root, 'node_modules/gliner/node_modules/onnxruntime-web')")
    // Not the hoisted one. That is the whole bug.
    expect(build).not.toMatch(/join\(\s*root,\s*'node_modules\/onnxruntime-web/)
  })

  it('aliases a copy whose version satisfies gliner', () => {
    const aliased = json(
      'node_modules/gliner/node_modules/onnxruntime-web/package.json',
    ).version as unknown as string
    expect(aliased).toBe(required)
  })

  it('that copy converts int64 number arrays rather than throwing', async () => {
    // The behaviour itself, not the version string — a future bump is fine
    // so long as this still holds.
    // Specifier built at runtime: the runtime ships no type declarations for
    // this dist file, and a literal would make `tsc` demand one.
    const from = new URL(
      '../../../node_modules/gliner/node_modules/onnxruntime-web/dist/ort.bundle.min.mjs',
      import.meta.url,
    ).href
    const ort = (await import(/* @vite-ignore */ from)) as {
      Tensor: new (t: string, d: number[], s: number[]) => { data: BigInt64Array }
    }
    const tensor = new ort.Tensor('int64', [1, 2, 3], [3])
    expect([...tensor.data]).toEqual([1n, 2n, 3n])
  })

  it('copies the wasm binary that runtime names, without writing it down', () => {
    // The filename moved once already: 1.14 picks between four binaries on
    // `(simd, numThreads > 1)`, 1.19 ships one. Reading it out of the bundle
    // means an upgrade cannot silently serve a 404.
    expect(build).toMatch(/const ORT_WASM = \(await readFile\(/)
    expect(build).toMatch(/GLINER_ORT, 'dist', ORT_WASM/)

    const runtime = readFileSync(
      new URL('node_modules/gliner/node_modules/onnxruntime-web/dist/ort.bundle.min.mjs', root),
      'utf8',
    )
    const named = /ort-wasm[\w.-]*\.wasm/.exec(runtime)?.[0]
    expect(named, 'the runtime no longer names a .wasm file').toBeDefined()
    expect(existsSync(new URL(
      `node_modules/gliner/node_modules/onnxruntime-web/dist/${named}`, root,
    ))).toBe(true)
  })
})

describe('the app serves the runtime binary its own JavaScript loads', () => {
  const provision = readFileSync(
    new URL('../../../scripts/provision-model.mjs', import.meta.url),
    'utf8',
  )

  /**
   * The extension is not the only host that copies this file. `provision`
   * puts a `.wasm` under `public/models/ort/` for the app, and it read from
   * the hoisted 1.14 package while the app's gliner loads 1.19.
   *
   * The emscripten glue and its `.wasm` are one artifact built together, so a
   * mismatched pair cannot instantiate — and the confirmer catches that and
   * degrades to deep-context. Silent, and indistinguishable from the model
   * never having been provisioned. The app looked like it was working.
   */
  it('copies from gliner’s runtime, not the hoisted one', () => {
    expect(provision).toContain("'gliner', 'node_modules', 'onnxruntime-web'")
    expect(provision).toContain("const wasmSource = join(GLINER_ORT, 'dist', ORT_WASM)")
  })

  it('reads the filename out of the runtime rather than hardcoding it', () => {
    expect(provision).toMatch(/ORT_WASM = \(\s*await readFile\(/)
    expect(provision).not.toMatch(/const ORT_WASM = '[\w.-]+'/)
  })
})

describe('only one context has the model, and the rest ask it', () => {
  const background = read('../background.ts')
  const offscreen = read('../offscreen.ts')

  /**
   * `registerLocalModel` is called in the offscreen document and nowhere
   * else, so an escalation awaited anywhere else silently resolves to the
   * deterministic confirmer. That is not an error — it returns findings, it
   * just cannot see the names GLiNER exists to recover.
   *
   * Which is how the banner and the rewrite came to disagree about the same
   * sentence. The check was relayed to the offscreen document and reported
   * "Closer look caught 2 more"; the cleaning ran `scanWithConfirmation` in
   * the worker, got stage one's findings back, and masked none of them. Both
   * halves were working. They were answering in different places.
   */
  it('registers the model in exactly one place', () => {
    expect(offscreen).toContain('registerLocalModel(')
    // A call, not a mention — the comment in `background.ts` explaining why
    // it must not register one would otherwise fail this.
    expect(background).not.toMatch(/registerLocalModel\s*\(/)
  })

  it('never escalates in the worker, where the model is not', () => {
    // The worker may `scan` — that is stage one and needs no model. It must
    // not `scanWithConfirmation`, which looks identical and quietly is not.
    expect(background).not.toMatch(/scanWithConfirmation\s*\(/)
  })

  it('relays the rewrite’s findings, not just the banner’s', () => {
    // Both go through the same relay. If only one did, they could disagree
    // again — and the disagreement is invisible from either side alone.
    expect(background).toMatch(/relayToOffscreen<DeepCheckResponse/)
    expect(background).toMatch(/relayToOffscreen<OffscreenConfirmResponse/)
  })

  it('answers the confirm relay with offsets, not display text', () => {
    // `WireFinding` carries a label and a reason but no offsets, so nothing
    // can be rewritten from it. The confirm reply has to be the real thing.
    expect(offscreen).toContain("type: 'offscreen-confirm'")
    expect(offscreen).toMatch(/findings:\s*Finding\[\]/)
  })
})
