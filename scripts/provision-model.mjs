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
import { copyFile, mkdir, stat } from 'node:fs/promises'
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
 * project promises never to do. The file is already in node_modules, so this is
 * a copy rather than a download.
 *
 * Only the SIMD+threaded build is copied. It is the one `gliner` asks for by
 * name, and shipping the other three would be 27 MB of dead weight.
 */
const ORT_WASM = 'ort-wasm-simd-threaded.wasm'
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
const wasmSource = join(root, 'node_modules', 'onnxruntime-web', 'dist', ORT_WASM)
const wasmTarget = join(ORT_TARGET, ORT_WASM)
if ((await sizeOf(wasmTarget)) > 0) {
  console.log(`  have  ${`ort/${ORT_WASM}`.padEnd(28)} ${mb(await sizeOf(wasmTarget))}`)
} else {
  await copyFile(wasmSource, wasmTarget)
  console.log(`  copy  ${`ort/${ORT_WASM}`.padEnd(28)} ${mb(await sizeOf(wasmTarget))}`)
}
total += await sizeOf(wasmTarget)

console.log(`\nDone — ${mb(total)} provisioned.`)
console.log('The app will use it automatically on the next scan that needs it.')
console.log('Nothing is fetched from a third party at scan time.')
