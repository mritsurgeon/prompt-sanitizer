/**
 * Builds the extension for every supported browser — `npm run ext:build`.
 *
 * One codebase, two manifests. Chrome/Edge MV3 wants `background.service_worker`
 * and Firefox MV3 wants `background.scripts`; that single key is the entire
 * cross-browser difference, so it is resolved here rather than by forking the
 * extension. Safari ships Chromium-style MV3 through `safari-web-extension
 * -converter`, which consumes the Chrome build unchanged.
 */
import { build } from 'vite'
import { mkdir, writeFile, cp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'extension', 'dist')

/** `npm run ext:build -- --dev` also arms the extension on the local test bench. */
const dev = process.argv.includes('--dev')

const SITES = [
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*',
  'https://copilot.microsoft.com/*',
  'https://m365.cloud.microsoft/*',
]

/**
 * The local test bench, and only in a dev build.
 *
 * Never in a shipped manifest: an extension that runs on every localhost port
 * is an extension that reads whatever else you happen to be developing.
 */
const BENCH = ['http://localhost:4180/*', 'http://127.0.0.1:4180/*']

/**
 * The web app itself — the "Edit in AI Safe" destination, and where the
 * provisioned model files are served from.
 *
 * The content script runs here too, but for one job only: collecting a prompt
 * the user chose to hand over and putting it in the app's composer. Must stay
 * in step with `extension/src/config.ts`.
 */
const APP_ORIGINS = ['http://localhost:5173/*', 'http://localhost:4173/*']

const HOSTS = dev ? [...SITES, ...APP_ORIGINS, ...BENCH] : [...SITES, ...APP_ORIGINS]

const BASE = {
  manifest_version: 3,
  name: 'AI Safe — Prompt Sanitizer',
  version: '0.1.0',
  description:
    'Checks prompts on your device before they reach an AI service. Nothing is uploaded.',
  // Deliberately minimal. No history, no bookmarks, no host permissions beyond
  // the AI sites and the app itself, and no clipboardRead — the paste event
  // already carries the text.
  //
  // `tabs` is here only so "Edit in AI Safe" can open the app; the prompt
  // travels through session storage rather than the URL, so it never reaches
  // history or the omnibox.
  permissions: ['storage', 'tabs'],
  // Registers the enterprise policy template. Chromium reads this to build the
  // admin-console form and the GPO/plist templates, so the schema is the
  // documentation an administrator actually sees.
  storage: { managed_schema: 'managed_schema.json' },
  host_permissions: HOSTS,
  action: {
    default_popup: 'popup/popup.html',
    default_title: 'AI Safe — protected locally',
  },
  content_scripts: [
    {
      matches: HOSTS,
      js: ['content.js'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
}

/**
 * `wasm-unsafe-eval` is what MV3 calls "allowed to compile WebAssembly".
 *
 * The name is alarming and the capability is not: it permits
 * `WebAssembly.compile`, and nothing else. It does **not** enable `eval` or
 * `new Function` for JavaScript — MV3 has no way to permit those on an
 * extension page, and does not need to here. Without this key the ONNX runtime
 * cannot instantiate at all.
 */
const CSP = {
  extension_pages:
    "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
}

const MANIFESTS = {
  chrome: {
    ...BASE,
    // `offscreen` gives the second-stage model somewhere to stay resident. A
    // service worker is killed on idle, which would evict 183 MB of weights
    // between one prompt and the next.
    permissions: [...BASE.permissions, 'offscreen'],
    content_security_policy: CSP,
    background: { service_worker: 'background.js', type: 'module' },
  },
  firefox: {
    // No offscreen API in Firefox, so stage two runs in the worker there with
    // the deterministic confirmer. Requesting a permission the browser does not
    // recognise would make the whole manifest fail to load.
    ...BASE,
    content_security_policy: CSP,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: { id: 'ai-safe@promptsanitizer.local', strict_min_version: '115.0' },
    },
  },
}

/**
 * Each entry is built on its own and bundled whole.
 *
 * A content script is not an ES module — it is injected as a classic script,
 * so an `import` of a shared chunk resolves to nothing and the protection
 * silently never runs. Building the three entries separately costs a few
 * duplicated kilobytes and removes that entire failure mode.
 */
const ENTRIES = [
  ['background', 'extension/src/background.ts'],
  ['content', 'extension/src/content.entry.ts'],
  ['offscreen', 'extension/src/offscreen.ts'],
  ['popup/popup', 'extension/src/popup/popup.ts'],
]

/**
 * Cutting the ONNX runtime down to the one backend that can actually run here.
 *
 * `gliner` statically imports all three backends at module top —
 * `onnxruntime-web`, `/webgpu` and `/webgl` — so a bundler has no way to drop
 * the unused two. Left alone that was 44 MB of code which could never execute,
 * because the confirmer pins `executionProvider: 'wasm'`.
 *
 * The two GPU backends are aliased to a throwing stub, and the default entry is
 * redirected from the everything-included browser build to `ort.wasm.min.js` —
 * the WASM-only build, 0.15 MB against 15 MB. It exposes exactly the three
 * things `gliner` touches: `env.wasm`, `InferenceSession` and `Tensor`.
 */
const ORT_ALIASES = {
  'onnxruntime-web/webgpu': join(root, 'extension/src/ort-stub.ts'),
  'onnxruntime-web/webgl': join(root, 'extension/src/ort-stub.ts'),
  'onnxruntime-web': join(
    root,
    'node_modules/onnxruntime-web/dist/ort.wasm.min.js',
  ),
}

for (const [name, entry] of ENTRIES) {
  /**
   * The offscreen page is the one entry loaded as a real ES module by an HTML
   * page, so it can code-split. That matters: inlining its dynamic imports
   * pulls the model machinery in eagerly, when the point is that none of it
   * loads until stage two actually escalates.
   *
   * The other three must stay inlined — a content script is injected as a
   * classic script, and an MV3 service worker cannot dynamically import.
   */
  const splittable = name === 'offscreen'

  await build({
    root,
    configFile: false,
    // The app's public/ holds 193 MB of model weights. They belong to the web
    // app, not the extension, and copying them here would make every build
    // enormous. The extension fetches them from the app's origin instead.
    publicDir: false,
    resolve: {
      alias: { '@': join(root, 'src'), ...(splittable ? ORT_ALIASES : {}) },
    },
    build: {
      outDir: out,
      emptyOutDir: name === 'background',
      target: 'es2022',
      // Never base64-inline an asset — a 10 MB wasm becoming 13 MB of base64
      // inside a JavaScript file both doubles the disk cost and has to be
      // parsed as source before it can be compiled as WebAssembly.
      assetsInlineLimit: 0,
      // Explicit, because lib mode does not always apply it to vendor chunks:
      // the ONNX runtime came out at 14.6 MB pretty-printed from a 0.5 MB
      // minified source.
      minify: 'esbuild',
      lib: { entry: join(root, entry), formats: ['es'], fileName: () => `${name}.js` },
      rollupOptions: {
        output: {
          inlineDynamicImports: !splittable,
          ...(splittable ? { chunkFileNames: 'chunks/[name]-[hash].js' } : {}),
        },
      },
    },
  })
}

await cp(
  join(root, 'extension/src/offscreen.html'),
  join(out, 'offscreen.html'),
)

/**
 * The ONNX runtime's WebAssembly binary, shipped with the extension.
 *
 * Executable code is not fetched over the network — MV3 forbids it, and it
 * would defeat the point of the CSP. Only the model *weights* are fetched, and
 * only from the origin that provisioned them.
 */
const ORT_WASM = 'ort-wasm-simd-threaded.wasm'
await mkdir(join(out, 'wasm'), { recursive: true })
await cp(
  join(root, 'node_modules/onnxruntime-web/dist', ORT_WASM),
  join(out, 'wasm', ORT_WASM),
)

await mkdir(join(out, 'popup'), { recursive: true })
await cp(
  join(root, 'extension/src/popup/popup.html'),
  join(out, 'popup/popup.html'),
)
await cp(
  join(root, 'extension/src/popup/popup.css'),
  join(out, 'popup/popup.css'),
)

// popup.html is copied verbatim, so give it its stylesheet link.
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="./popup.css">`
const page = await import('node:fs/promises').then((fs) =>
  fs.readFile(join(out, 'popup/popup.html'), 'utf8'),
)
await writeFile(join(out, 'popup/popup.html'), html + page)

for (const [browser, manifest] of Object.entries(MANIFESTS)) {
  await writeFile(
    join(out, `manifest.${browser}.json`),
    JSON.stringify(manifest, null, 2),
  )
}
// Chrome loads `manifest.json` by name; Firefox users swap in the other file.
await writeFile(
  join(out, 'manifest.json'),
  JSON.stringify(MANIFESTS.chrome, null, 2),
)

// The enterprise policy template, referenced by the `storage.managed_schema`
// manifest key. Chromium builds the admin-console form and the GPO/plist
// templates from it, so it has to ship alongside the manifest that names it.
await cp(join(root, 'extension/managed_schema.json'), join(out, 'managed_schema.json'))

console.log(`\nExtension built into extension/dist`)
console.log('  Chrome/Edge : load unpacked, pick extension/dist')
console.log('  Firefox     : rename manifest.firefox.json to manifest.json first')
if (dev) {
  console.log('\n  dev build — also active on the test bench at localhost:4180')
  console.log('  run `npm run ext:bench` to serve it')
}
