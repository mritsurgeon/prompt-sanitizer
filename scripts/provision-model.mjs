/**
 * Provisions the GLiNER confirmer's model files — `npm run provision:model`.
 *
 * This is the only step that touches the network, and it happens once at
 * install time. Afterwards the files are served from the app's own origin and
 * nothing is fetched from a third party during a scan.
 *
 * Downloads ~195 MB into public/models/gliner-small/. That directory is
 * git-ignored: provision it per machine rather than committing the weights.
 */
import { createWriteStream } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, stat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'public', 'models', 'gliner-small')
const base = 'https://huggingface.co/onnx-community/gliner_small-v2.1/resolve/main'

/**
 * The ONNX runtime's WebAssembly binary, served from our own origin.
 *
 * `gliner` defaults `wasmPaths` to a jsDelivr CDN URL, which would make every
 * cold model load a third-party request at scan time — exactly what this
 * project promises never to do. The file is already in node_modules, so this
 * is a copy rather than a download.
 *
 * ## From gliner's copy, not the hoisted one
 *
 * There are two ONNX runtimes here. `@xenova/transformers@2.17.2` pins
 * `onnxruntime-web@1.14.0` and npm hoists it to the top level; `gliner`
 * requires `1.19.2`, which stays nested. Nothing declares the package
 * directly, so `node_modules/onnxruntime-web` is transformers' copy.
 *
 * This line used to read from there, which meant the app served a 1.14
 * binary to the 1.19 JavaScript that gliner actually loads. The glue and the
 * `.wasm` are one artifact built together — their imports have to match — so
 * the pair cannot instantiate, and a failed instantiation is caught and
 * degraded to the deterministic confirmer. Silent, and indistinguishable
 * from the model simply not being provisioned.
 *
 * The filename is read out of the runtime rather than written down, because
 * the two versions do not agree on it either: 1.14 picks between four
 * binaries on `(simd, numThreads > 1)`, 1.19 ships one.
 */
const GLINER_ORT = join(root, 'node_modules', 'gliner', 'node_modules', 'onnxruntime-web')
const ORT_WASM = (
  await readFile(join(GLINER_ORT, 'dist', 'ort.bundle.min.mjs'), 'utf8')
).match(/ort-wasm[\w.-]*\.wasm/)?.[0]

if (!ORT_WASM) {
  throw new Error(
    'Could not find the .wasm filename inside the ONNX runtime bundle. An ' +
      'upgrade has changed how it names its binary; check what ' +
      'dist/ort.bundle.min.mjs now references.',
  )
}

const ORT_TARGET = join(root, 'public', 'models', 'ort')

/** int8 weights — the smallest build that keeps full accuracy on our corpus. */
const FILES = [
  'config.json',
  'gliner_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  ['onnx/model_quantized.onnx', 'onnx/model.onnx'],
]

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function download(from, to) {
  const destination = join(target, to)
  await mkdir(dirname(destination), { recursive: true })

  const existing = await sizeOf(destination)
  if (existing > 0) {
    console.log(`  have  ${to.padEnd(28)} ${mb(existing)}`)
    return existing
  }

  const response = await fetch(`${base}/${from}`)
  if (!response.ok || !response.body) {
    throw new Error(`${from}: ${response.status} ${response.statusText}`)
  }

  process.stdout.write(`  get   ${to.padEnd(28)} …`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))

  const written = await sizeOf(destination)
  process.stdout.write(`\r  got   ${to.padEnd(28)} ${mb(written)}\n`)
  return written
}

console.log(`Provisioning GLiNER small v2.1 into public/models/gliner-small\n`)

let total = 0
for (const entry of FILES) {
  const [from, to] = Array.isArray(entry) ? entry : [entry, entry]
  total += await download(from, to)
}

// The runtime, from node_modules rather than the network.
await mkdir(ORT_TARGET, { recursive: true })
const wasmSource = join(GLINER_ORT, 'dist', ORT_WASM)
const wasmTarget = join(ORT_TARGET, ORT_WASM)
if ((await sizeOf(wasmTarget)) > 0) {
  console.log(`  have  ${`ort/${ORT_WASM}`.padEnd(28)} ${mb(await sizeOf(wasmTarget))}`)
} else {
  await copyFile(wasmSource, wasmTarget)
  console.log(`  copy  ${`ort/${ORT_WASM}`.padEnd(28)} ${mb(await sizeOf(wasmTarget))}`)
}
total += await sizeOf(wasmTarget)

/**
 * Prune the vocabulary, if this machine can.
 *
 * The embedding table is 54% of the checkpoint, and dropping it to 32k tokens
 * makes the artifact 40% smaller and roughly twice as fast to load at
 * identical accuracy — so it is worth doing by default rather than leaving
 * behind an optional flag most people never find.
 *
 * Best effort on purpose. It needs Python with `onnx` and `numpy`, and
 * provisioning must keep working on a machine that has neither: the confirmer
 * prefers the pruned checkpoint when it exists and falls back to the full one
 * when it does not, so a failure here costs download size, not function.
 */
console.log('\nPruning the vocabulary (optional, needs python3 with onnx + numpy)…')
const pruned = spawnSync(
  'python3',
  [join(root, 'scripts', 'prune-vocab.py'), '--keep', '32000',
   '--src', target, '--out', join(root, 'public', 'models', 'gliner-small-32k')],
  { cwd: root, encoding: 'utf8' },
)
if (pruned.status === 0) {
  for (const line of pruned.stdout.trim().split('\n')) console.log(`  ${line}`)
  console.log('  the confirmer will prefer this smaller checkpoint automatically')
} else {
  const why = (pruned.stderr || pruned.error?.message || '').trim().split('\n').pop()
  console.log(`  skipped — ${why || 'python3 unavailable'}`)
  console.log('  not a problem: the full checkpoint is used instead.')
  console.log('  to get the 40% smaller one later: pip install onnx numpy && npm run provision:prune')
}

console.log(`\nDone — ${mb(total)} provisioned.`)
console.log('The app will use it automatically on the next scan that needs it.')
console.log('Nothing is fetched from a third party at scan time.')
