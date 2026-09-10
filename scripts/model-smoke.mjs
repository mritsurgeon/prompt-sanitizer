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
    contents:
      `export { Gliner } from 'gliner'\n` +
      `export { env } from '@xenova/transformers'\n` +
      `export * as ort from 'onnxruntime-web'\n`,
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
  const mod = await import(pathToFileURL(bundle).href)

  // On the bundle's own instances. Reaching for a separately-imported copy
  // sets the flag on an object the runtime never reads — which is exactly
  // how `multiThread: false` managed to be a no-op in the extension.
  const ort = mod.ort.default ?? mod.ort
  ort.env.wasm.numThreads = 1
  ort.env.wasm.wasmPaths = `${origin}/wasm/`

  mod.env.allowRemoteModels = true
  mod.env.allowLocalModels = false
  mod.env.remoteHost = `${origin}/models/`
  mod.env.remotePathTemplate = '{model}'
  mod.env.useBrowserCache = false
  mod.env.useFSCache = false

  const started = Date.now()
  const gliner = new mod.Gliner({
    tokenizerPath: 'gliner-small',
    onnxSettings: {
      modelPath: `${origin}/models/gliner-small/onnx/model.onnx`,
      executionProvider: 'wasm',
      wasmPaths: `${origin}/wasm/`,
      multiThread: false,
    },
    maxWidth: 12,
    modelType: 'span-level',
    transformersSettings: { allowLocalModels: false, useBrowserCache: false },
  })
  await gliner.initialize()
  const loadMs = Date.now() - started

  const [spans] = await gliner.inference({
    texts: [SENTENCE],
    entities: ['person', 'organization', 'location'],
    threshold: 0.45,
    flatNer: true,
  })

  console.log(`\nloaded in ${(loadMs / 1000).toFixed(1)}s, ${spans.length} spans:`)
  for (const s of spans) {
    console.log(`  ${s.label.padEnd(13)} ${JSON.stringify(s.spanText).padEnd(21)} ${s.score.toFixed(3)}`)
  }

  const found = new Set(spans.filter((s) => s.label === 'person').map((s) => s.spanText.trim()))
  const missing = EXPECTED.filter((name) => !found.has(name))
  if (missing.length) failure = `the model did not find: ${missing.join(', ')}`
} catch (cause) {
  failure = cause instanceof Error ? `${cause.message}` : String(cause)
} finally {
  server.close()
  await rm(bundle, { force: true })
}

if (failure) die(failure)
console.log('\n✓ the extension’s model path works end to end')
