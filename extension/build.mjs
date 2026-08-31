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

const MANIFESTS = {
  chrome: {
    ...BASE,
    background: { service_worker: 'background.js', type: 'module' },
  },
  firefox: {
    ...BASE,
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
  ['content', 'extension/src/content.ts'],
  ['popup/popup', 'extension/src/popup/popup.ts'],
]

for (const [name, entry] of ENTRIES) {
  await build({
    root,
    configFile: false,
    // The app's public/ holds 185 MB of model weights. They belong to the web
    // app, not the extension, and copying them here would make every build
    // enormous and ship the model into a context that never loads it.
    publicDir: false,
    resolve: { alias: { '@': join(root, 'src') } },
    build: {
      outDir: out,
      emptyOutDir: name === 'background',
      target: 'es2022',
      lib: { entry: join(root, entry), formats: ['es'], fileName: () => `${name}.js` },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })
}

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

console.log(`\nExtension built into extension/dist`)
console.log('  Chrome/Edge : load unpacked, pick extension/dist')
console.log('  Firefox     : rename manifest.firefox.json to manifest.json first')
if (dev) {
  console.log('\n  dev build — also active on the test bench at localhost:4180')
  console.log('  run `npm run ext:bench` to serve it')
}
