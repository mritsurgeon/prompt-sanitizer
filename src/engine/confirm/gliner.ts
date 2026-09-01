import {
  isInstitutionPhrase,
  isJobTitlePhrase,
  isSentenceStarter,
  isTechAcronym,
} from '../gazetteer'
import type { CategoryId } from '../types'
import type {
  ConfirmationRequest,
  ConfirmationVerdict,
  DiscoveredEntity,
  LocalModelDetector,
} from './types'

/**
 * GLiNER as the second-stage confirmer.
 *
 * The rules do the finding; this checks their work on the cases they could not
 * settle. It answers in both directions:
 *
 *  - **False positives** — an ambiguous candidate the rules called (`Christian`,
 *    `Hyundai`) is rejected if GLiNER sees no entity there.
 *  - **False negatives** — a capitalised word no gazetteer recognises
 *    (`Aarav Krishnamurthy`) is promoted if GLiNER does see one, and any entity
 *    in the window that the rules never proposed at all is added outright.
 *
 * Both come from a single pass: GLiNER returns spans with character offsets, so
 * one inference per window both adjudicates the candidates inside it and
 * surfaces what was missed.
 *
 * Model files are provisioned once (`npm run provision:model`) and served from
 * the app's own origin. Nothing is fetched from a third party at scan time.
 */

/**
 * The entity labels we ask for, and how they map back to our categories.
 *
 * GLiNER takes its labels as free text at inference time, so a PII-tuned
 * checkpoint answers better to "company" than to "organization". Configurable
 * per model rather than hard-coded.
 */
const DEFAULT_LABELS: Record<string, CategoryId> = {
  person: 'PERSON',
  organization: 'ORGANISATION',
  location: 'LOCATION',
}

const ADJUDICATED = new Set<CategoryId>(['PERSON', 'ORGANISATION', 'LOCATION'])

export interface GlinerOptions {
  /**
   * Where the tokenizer lives. In the browser this is the transformers.js
   * local model root; in Node it is the directory containing `modelName`.
   */
  basePath?: string
  /** Folder name of the provisioned model under `basePath`. */
  modelName?: string
  /** Full path or URL to the .onnx weights. */
  modelFile?: string
  /**
   * Where the ONNX runtime's WebAssembly binary is served from.
   *
   * Must always be set. `gliner` defaults this to a jsDelivr CDN URL, so
   * leaving it unset makes every cold model load a third-party request at scan
   * time — which this project promises never to do. `npm run provision:model`
   * copies the binary out of node_modules into our own origin.
   */
  wasmPaths?: string
  /** Minimum span score to believe. */
  threshold?: number
  maxWidth?: number
  /** Entity label -> category. Overridden for PII-tuned checkpoints. */
  labels?: Record<string, CategoryId>
}

interface GlinerSpan {
  spanText: string
  start: number
  end: number
  label: string
  score: number
}

/**
 * WebGPU is a large speedup for model start-up, but it is not everywhere:
 * Safari and Firefox have shipped it only recently, and it is unavailable in
 * a service worker. Feature-detected rather than assumed.
 */
function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

const isNode =
  typeof process !== 'undefined' &&
  process.versions?.node != null &&
  typeof window === 'undefined'

const DEFAULTS: Required<GlinerOptions> = {
  basePath: '/models/',
  modelName: 'gliner-small',
  modelFile: '/models/gliner-small/onnx/model.onnx',
  // Our own origin, never the CDN gliner would otherwise reach for.
  wasmPaths: '/models/ort/',
  threshold: 0.45,
  maxWidth: 12,
  labels: DEFAULT_LABELS,
}

/**
 * Builds a confirmer backed by GLiNER. Nothing is loaded until the gate
 * actually escalates something.
 */
export function createGlinerConfirmer(
  options: GlinerOptions = {},
): LocalModelDetector {
  const config = { ...DEFAULTS, ...options }

  let model: { inference: (a: unknown) => Promise<GlinerSpan[][]> } | null = null
  let loading: Promise<void> | null = null
  let available: boolean | null = null
  let loadMs: number | null = null
  let perCandidateMs: number | null = null

  /** Cheap existence check. Must not load the weights. */
  async function isAvailable(): Promise<boolean> {
    if (available !== null) return available
    try {
      if (isNode) {
        // Built dynamically so the bundler cannot statically resolve it and
        // drag Node built-ins into the browser build.
        const fs = await import(/* @vite-ignore */ 'node:fs'.slice(0))
        available = fs.existsSync(config.modelFile)
      } else {
        const response = await fetch(config.modelFile, { method: 'HEAD' })
        available = response.ok
      }
    } catch {
      available = false
    }
    return available ?? false
  }

  async function load(): Promise<void> {
    if (model) return
    if (loading) return loading

    loading = (async () => {
      const started = performance.now()

      // The browser build pulls in onnxruntime-web; the node build uses
      // onnxruntime-node.
      //
      // These two imports must be written differently on purpose. The browser
      // one is a literal so the bundler rewrites it to the built chunk — hide
      // it behind a variable and the output keeps a bare "gliner" specifier,
      // which no browser can resolve at runtime. The Node one is built from a
      // variable precisely so the bundler leaves it alone and does not ship
      // onnxruntime-node to the browser.
      const nodeEntry = 'gliner' + '/node'
      const { Gliner } = isNode
        ? ((await import(/* @vite-ignore */ nodeEntry)) as typeof import('gliner'))
        : await import('gliner')

      // transformers.js resolves the tokenizer relative to this root, and must
      // be told to read locally rather than reach for HuggingFace.
      const transformers = await import('@xenova/transformers')
      transformers.env.allowRemoteModels = false
      transformers.env.allowLocalModels = true
      transformers.env.localModelPath = config.basePath

      const instance = new Gliner({
        tokenizerPath: config.modelName,
        // Node takes only a path; the web build also wants an execution
        // provider and is worth letting use more than one thread.
        onnxSettings: isNode
          ? { modelPath: config.modelFile }
          : {
              modelPath: config.modelFile,
              // WebGPU where the browser has it — it moves the one-off startup
              // from seconds to under a second on a laptop GPU, and that
              // startup is the only part of this anybody notices. WASM
              // otherwise, which is every browser; the model runs either way.
              executionProvider: hasWebGPU() ? 'webgpu' : 'wasm',
              // Explicit, because gliner's default is a jsDelivr CDN URL and a
              // scan must never depend on a third party being reachable.
              wasmPaths: config.wasmPaths,
              multiThread: true,
            },
        maxWidth: config.maxWidth,
        modelType: 'span-level',
        transformersSettings: {
          allowLocalModels: true,
          useBrowserCache: !isNode,
        },
      })

      await instance.initialize()
      model = instance as unknown as {
        inference: (a: unknown) => Promise<GlinerSpan[][]>
      }
      loadMs = performance.now() - started
    })()

    try {
      await loading
    } finally {
      loading = null
    }
  }

  async function confirm(
    requests: ConfirmationRequest[],
  ): Promise<ConfirmationVerdict[]> {
    if (!model) throw new Error('GLiNER was asked to confirm before loading')
    if (!requests.length) return []

    // Requests overlap heavily — several candidates in one sentence share a
    // window. Deduplicate so each distinct window costs one forward pass.
    const windows: string[] = []
    const indexOfWindow = new Map<string, number>()
    for (const request of requests) {
      if (!indexOfWindow.has(request.window)) {
        indexOfWindow.set(request.window, windows.length)
        windows.push(request.window)
      }
    }

    const started = performance.now()
    const results = await model.inference({
      texts: windows,
      entities: Object.keys(config.labels),
      threshold: config.threshold,
      flatNer: true,
    })
    perCandidateMs = (performance.now() - started) / requests.length

    const spansFor = (window: string): GlinerSpan[] =>
      results[indexOfWindow.get(window) ?? -1] ?? []

    // Track which spans were used to answer a request, so the rest can be
    // reported as things the rules never proposed.
    const claimed = new Map<string, Set<number>>()
    const claim = (window: string, index: number) => {
      const set = claimed.get(window) ?? new Set<number>()
      set.add(index)
      claimed.set(window, set)
    }

    const verdicts: ConfirmationVerdict[] = requests.map((request) => {
      // The model only knows people, companies and places. On anything else it
      // has no opinion, and must not be allowed to overturn a rule.
      if (!ADJUDICATED.has(request.category)) {
        return { id: request.id, decision: 'unknown', confidence: 0.5 }
      }

      const spans = spansFor(request.window)
      const from = request.offset
      const to = request.offset + request.value.length

      let best: GlinerSpan | null = null
      let bestIndex = -1
      spans.forEach((span, index) => {
        if (span.start >= to || span.end <= from) return
        if (!best || span.score > best.score) {
          best = span
          bestIndex = index
        }
      })

      if (best) {
        claim(request.window, bestIndex)
        const span = best as GlinerSpan
        const asCategory = config.labels[span.label]
        const agrees = asCategory === request.category
        return {
          id: request.id,
          decision: 'confirm',
          confidence: span.score,
          // Hand back the model's own label. The rules guess the category from
          // shape, so an unrecognised capitalised phrase arrives as a possible
          // person whether it is one or not.
          category: asCategory,
          note: agrees
            ? `GLiNER reads "${span.spanText}" as a ${span.label} here.`
            : `GLiNER reads "${span.spanText}" as a ${span.label}, not what the rules guessed.`,
        }
      }

      return {
        id: request.id,
        decision: 'reject',
        confidence: 0.8,
        note: request.unresolved
          ? undefined
          : 'GLiNER found no name, company or place at this position.',
      }
    })

    // Anything the model saw that no request asked about is a miss the rules
    // never even proposed.
    const seen = new Set<string>()
    for (const request of requests) {
      if (seen.has(request.window)) continue
      seen.add(request.window)

      const used = claimed.get(request.window) ?? new Set<number>()
      const discovered: DiscoveredEntity[] = []

      spansFor(request.window).forEach((span, index) => {
        if (used.has(index)) return
        const asCategory = config.labels[span.label]
        if (!asCategory) return
        if (span.score < config.threshold) return
        // Discovery is unprompted, so hold it to a stricter standard than an
        // answer to a question we asked. A named entity in English text is
        // capitalised; a lower-case span is the model latching onto a common
        // noun ("procurement", "the vendor") rather than a name.
        const text = span.spanText.trim()
        if (!/^[A-Z]/.test(text)) return
        if (text.length < 2) return
        // Discovery bypasses the rules entirely, so it has to re-apply the
        // exclusions they would have made: "PM", "SQL", "VBR" are vocabulary,
        // not names, and "The"/"Delivered" are just capitalised words.
        if (text.split(/\s+/).every((word) => isTechAcronym(word))) return
        if (text.split(/\s+/).every((word) => isSentenceStarter(word))) return
        // A role or a place of study sits exactly where a name sits, so a
        // model reads it as one. The rules already refuse these; discovery
        // bypasses the rules, so it has to refuse them too.
        if (isJobTitlePhrase(text) || isInstitutionPhrase(text)) return
        // People do not have digits in their names. "MCITP 70-686" and
        // "HP2-037" are product and certification codes.
        if (asCategory === 'PERSON' && /\d/.test(text)) return
        discovered.push({
          value: span.spanText,
          category: asCategory,
          start: request.windowStart + span.start,
          end: request.windowStart + span.end,
          confidence: span.score,
        })
      })

      if (discovered.length) {
        const verdict = verdicts.find((v) => v.id === request.id)
        if (verdict) verdict.discovered = discovered
      }
    }

    return verdicts
  }

  return {
    id: 'gliner-small-v2.1',
    label: 'GLiNER check',
    get cost() {
      return {
        bytes: 195_000_000,
        startupMs: loadMs,
        perCandidateMs,
      }
    },
    isAvailable,
    load,
    confirm,
    get loaded() {
      return model !== null
    },
  }
}
