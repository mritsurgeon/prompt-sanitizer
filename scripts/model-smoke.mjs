/**
 * Runs the extension's model path for real, outside a browser.
 *
 * Every unit test in this repo stubs the model or runs it through
 * `gliner/node`, and neither exercises what the offscreen document actually
 * does. That gap cost four rounds of debugging: an execution provider that
 * had been aliased away, threads the MV3 CSP forbids, a `.wasm` filename the
 * runtime had stopped asking for, and — the one nothing caught — the wrong
 * copy of `onnxruntime-web`, five minor versions behind what `gliner`
 * targets, whose `Tensor` cannot build an int64 from a number array.
 *
 * Each failed in the browser and nowhere else, because each was a property
 * of what `build.mjs` bundles rather than of any source file. So this runs
 * the bundle's own resolution: the same aliases, the same runtime copy, the
 * same single-threaded setting, real weights served over HTTP from another
 * origin. If a name comes back, the extension's model path works.
 *
 *     npm run check:model
 *
 * Node has no `Worker`, which makes the run stricter than the browser: if
 * ORT tried to spawn one this would throw rather than quietly succeed.
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, stat, rm, mkdir } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const GLINER_ORT = join(root, 'node_modules/gliner/node_modules/onnxruntime-web')
const WEIGHTS = join(root, 'public/models')

/** Two names the word lists cannot resolve alone — the model's whole job. */
const SENTENCE =
  'During yesterday’s strategic summit in Dublin, Malik Vance finalized the ' +
  'acquisition framework alongside Tariq Al-Mansoor from the board.'
const EXPECTED = ['Malik Vance', 'Tariq Al-Mansoor']

const die = (message) => {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

try {
  await stat(join(WEIGHTS, 'gliner-small/onnx/model.onnx'))
} catch {
  die('No weights at public/models/gliner-small. Run `npm run provision:model` first.')
}

/**
 * Bundled rather than imported, and not only to mirror the extension.
 * `onnxruntime-web@1.19`'s exports map sets `"node": null` on `./webgpu`, so
 * importing `gliner` directly under Node fails on a subpath the extension
 * aliases away anyway.
 */
// Inside the project, not `tmpdir()`: the bundle keeps `onnxruntime-node`
// and `sharp` external, and those only resolve from here.
const cache = join(root, 'node_modules/.cache')
await mkdir(cache, { recursive: true })
const bundle = join(cache, `ai-safe-model-smoke-${process.pid}.mjs`)
await build({
  // `stdin` with an explicit `resolveDir`, so the bare specifiers resolve
  // from the project rather than from wherever the output happens to sit.
  stdin: {
    // The engine's confirmer, not `gliner` directly. Driving gliner proves
    // gliner works; the thing that kept breaking is the wrapper — which
    // execution provider it asks for, whether it writes `numThreads` to the
    // module the runtime actually reads, and whether it reports back what
    // ran. `ep` was `'none'` for the extension's whole life while the model
    // was believed to be running, so the check has to read it.
    contents: `export { createGlinerConfirmer } from '@/engine/confirm/gliner'\n`,
    resolveDir: root,
    sourcefile: 'model-smoke-entry.mjs',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  absWorkingDir: root,
  // The same three aliases `build.mjs` applies. If those drift from these,
  // this check stops describing the extension.
  alias: {
    '@': join(root, 'src'),
    'onnxruntime-web/webgpu': join(root, 'extension/src/ort-stub.ts'),
    'onnxruntime-web/webgl': join(root, 'extension/src/ort-stub.ts'),
    'onnxruntime-web': join(GLINER_ORT, 'dist/ort.bundle.min.mjs'),
  },
  external: ['sharp', 'onnxruntime-node'],
  logLevel: 'error',
})

const TYPES = {
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
  '.model': 'application/octet-stream',
}

// The offscreen document fetches weights cross-origin and the runtime from
// its own origin. One server, two prefixes, is close enough to reproduce the
// fetching without pretending to reproduce the CSP.
const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x')
  const file = pathname.startsWith('/wasm/')
    ? join(GLINER_ORT, 'dist', pathname.slice(6))
    : join(WEIGHTS, pathname.replace(/^\/models\//, ''))
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file')
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

let failure = null
try {
  /**
   * `window`, so the confirmer takes its browser path.
   *
   * `gliner.ts` decides between `gliner/node` + onnxruntime-node and
   * `gliner` + onnxruntime-web on `typeof window === 'undefined'`. Left
   * alone under Node it would exercise the path that has never broken, and
   * report `ep: 'none'` while doing it. Defining `window` is the whole
   * reason this check can see the browser branch at all.
   */
  globalThis.window ??= globalThis

  /**
   * A no-op Cache API, because declaring `window` has consequences.
   *
   * The confirmer passes `useBrowserCache: !isNode` to gliner, so the
   * browser branch asks transformers.js to cache the tokenizer in the Cache
   * API — which Node does not have. `match` returning nothing means every
   * request falls through to `fetch`, which is what this check wants anyway:
   * a cold load every run, against the server below.
   */
  globalThis.caches ??= {
    open: async () => ({ match: async () => undefined, put: async () => {} }),
  }

  const { createGlinerConfirmer } = await import(pathToFileURL(bundle).href)

  // The offscreen document's configuration, verbatim.
  const confirmer = createGlinerConfirmer({
    basePath: `${origin}/models/`,
    modelName: 'gliner-small',
    modelFile: `${origin}/models/gliner-small/onnx/model.onnx`,
    wasmPaths: `${origin}/wasm/`,
    executionProvider: 'wasm',
    multiThread: false,
  })

  if (!(await confirmer.isAvailable())) throw new Error('the confirmer reports no checkpoint')

  const started = Date.now()
  await confirmer.load()
  const loadMs = Date.now() - started

  const { ep, labelCount } = confirmer.runtime
  console.log(`\nloaded in ${(loadMs / 1000).toFixed(1)}s  ·  ep ${ep}  ·  ${labelCount} labels`)

  // One window, one candidate per name, exactly as `windowsFor` builds them.
  const candidates = EXPECTED.map((value, i) => ({
    id: `c${i}`,
    value,
    category: 'PERSON',
    window: SENTENCE,
    offset: SENTENCE.indexOf(value),
    windowStart: 0,
    unresolved: true,
  }))

  const decisions = await confirmer.confirm(candidates)
  for (const d of decisions) {
    const name = candidates.find((c) => c.id === d.id)?.value
    console.log(
      `  ${String(d.decision).padEnd(8)} ${JSON.stringify(name).padEnd(21)} ${d.confidence.toFixed(3)}`,
    )
  }

  const problems = []

  // `wasm-single`, not merely "something": `wasm-threaded` here would mean
  // `numThreads` was written to a module the runtime does not read, which is
  // how the MV3 blob-worker failures happened.
  if (ep !== 'wasm-single') problems.push(`ep is ${ep}, expected wasm-single`)
  if (labelCount !== 3) problems.push(`${labelCount} labels, expected 3`)

  const confirmed = new Set(
    decisions.filter((d) => d.decision === 'confirm').map((d) => candidates.find((c) => c.id === d.id)?.value),
  )
  const missing = EXPECTED.filter((name) => !confirmed.has(name))
  if (missing.length) problems.push(`not confirmed as people: ${missing.join(', ')}`)

  if (problems.length) failure = problems.join('; ')
} catch (cause) {
  failure = cause instanceof Error ? `${cause.message}` : String(cause)
} finally {
  server.close()
  await rm(bundle, { force: true })
}

if (failure) die(failure)
console.log('\n✓ the extension’s model path works end to end')
