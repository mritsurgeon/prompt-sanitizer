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
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'public', 'models', 'gliner-small')
const base = 'https://huggingface.co/onnx-community/gliner_small-v2.1/resolve/main'

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

console.log(`\nDone — ${mb(total)} provisioned.`)
console.log('The app will use it automatically on the next scan that needs it.')
