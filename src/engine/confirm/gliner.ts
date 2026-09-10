import {
  isInstitutionPhrase,
  isJobTitlePhrase,
  isSentenceStarter,
  isTechAcronym,
} from '../gazetteer'
import type { ExecutionProvider } from '../metrics'
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

/**
 * A provisioned checkpoint. Several may be installed; the first one that
 * actually exists wins.
 */
export interface GlinerVariant {
  /** Folder under `basePath`, and the tokenizer path. */
  modelName: string
  /** Provisioned size — the escalation gate and the metrics both read this. */
  bytes: number
}

/**
 * Preference order.
 *
 * The pruned checkpoint is 40% smaller (109.7 MB against 183.4 MB) and loads
 * in roughly half the time, at identical accuracy: held-out F1 95.2%/100%, 13
 * findings on the dense document, 8/8 rare-name recall — every figure the same
 * as the full checkpoint across three runs. So it is preferred when present.
 *
 * It is preferred rather than required because producing it needs Python with
 * `onnx` and `numpy` (`npm run provision:prune`), and `npm run provision:model`
 * alone must keep working on a machine that has neither.
 */
const VARIANTS: GlinerVariant[] = [
  { modelName: 'gliner-small-32k', bytes: 110_000_000 },
  { modelName: 'gliner-small', bytes: 195_000_000 },
]

export interface GlinerOptions {
  /**
   * Where the tokenizer lives. In the browser this is the transformers.js
   * local model root; in Node it is the directory containing `modelName`.
   */
  basePath?: string
  /**
   * Pin one checkpoint instead of resolving by preference. Supplying either
   * this or `modelFile` disables variant resolution, which is what the
   * benchmark scripts want — they score a named artifact, not "whatever is
   * installed".
   */
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
  /**
   * Which ONNX backend to ask for.
   *
   * Must be stated by the host, because the answer depends on what that host
   * *bundled* and nothing here can see that. The extension ships the WASM-only
   * runtime and aliases the GPU backends to a throwing stub — 16 kB against
   * 44 MB — so asking for WebGPU there fails at session construction. It did:
   * feature-detecting on `navigator.gpu`, which exists in an offscreen
   * document, requested a backend that had been deliberately removed, and the
   * confirmer fell back to deep-context on every single escalation without
   * anyone noticing.
   *
   * Left undefined it feature-detects, which is right for the app, where the
   * whole runtime is present.
   */
  executionProvider?: 'wasm' | 'webgpu'
  /**
   * Provisioned size of this checkpoint.
   *
   * Not cosmetic: the escalation gate keys on whether a confirmer has weights
   * at all (`bytes === 0` means free to run, so it is never gated), and a
   * pruned artifact is 40% smaller than the default. Reporting the wrong
   * figure misstates the cost of every escalation in the metrics.
   */
  bytes?: number
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

/**
 * Can this context actually run WASM threads?
 *
 * `onnxruntime-web`'s threaded build needs `SharedArrayBuffer`, which needs
 * cross-origin isolation — `Cross-Origin-Opener-Policy: same-origin` plus
 * `Cross-Origin-Embedder-Policy: require-corp`. Asking for threads without it
 * does not degrade politely: the load hangs rather than falling back, so the
 * confirmer never resolves and the scan waits out its budget.
 *
 * Checked rather than assumed, because the contexts differ. The Vite dev
 * server sends those headers; a plain static host does not. An MV3 extension
 * page is isolated only if the manifest declares both keys. So the same code
 * runs threaded in one place and single-threaded in another, and the envelope
 * has to say which.
 */
function isIsolated(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true
}

const isNode =
  typeof process !== 'undefined' &&
  process.versions?.node != null &&
  typeof window === 'undefined'

const DEFAULTS = {
  basePath: '/models/',
  // Our own origin, never the CDN gliner would otherwise reach for.
  wasmPaths: '/models/ort/',
  threshold: 0.45,
  maxWidth: 12,
  labels: DEFAULT_LABELS,
} satisfies Partial<GlinerOptions>

/** Derived from `basePath` so the two can never disagree about a location. */
const fileFor = (basePath: string, modelName: string) =>
  `${basePath.replace(/\/+$/, '')}/${modelName}/onnx/model.onnx`

interface Resolved {
  modelName: string
  modelFile: string
  bytes: number
}

async function exists(path: string): Promise<boolean> {
  try {
    if (isNode) {
      // Built dynamically so the bundler cannot statically resolve it and
      // drag Node built-ins into the browser build.
      const fs = await import(/* @vite-ignore */ 'node:fs'.slice(0))
      return fs.existsSync(path)
    }
    return (await fetch(path, { method: 'HEAD' })).ok
  } catch {
    return false
  }
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
  let loadMs: number | null = null
  let perCandidateMs: number | null = null
  /** The backend that actually started, for the metrics envelope. */
  let provider: ExecutionProvider = 'none'

  /** Which checkpoint we settled on, once the question has been asked. */
  let resolved: Resolved | null = null
  let resolving: Promise<Resolved | null> | null = null

  const pinned = options.modelName != null || options.modelFile != null

  async function resolve(): Promise<Resolved | null> {
    if (resolved) return resolved
    if (resolving) return resolving

    resolving = (async () => {
      const candidates: Resolved[] = pinned
          ? [
              {
                modelName: options.modelName ?? VARIANTS[VARIANTS.length - 1].modelName,
                modelFile:
                  options.modelFile ??
                  fileFor(config.basePath, options.modelName as string),
                bytes: options.bytes ?? VARIANTS[VARIANTS.length - 1].bytes,
              },
            ]
          : VARIANTS.map((v) => ({
              modelName: v.modelName,
              modelFile: fileFor(config.basePath, v.modelName),
              bytes: options.bytes ?? v.bytes,
            }))

      for (const candidate of candidates) {
        if (await exists(candidate.modelFile)) {
          resolved = candidate
          return resolved
        }
      }
      return null
    })().finally(() => {
      resolving = null
    })

    return resolving
  }

  /** Cheap existence check. Must not load the weights. */
  async function isAvailable(): Promise<boolean> {
    return (await resolve()) !== null
  }

  async function load(): Promise<void> {
    if (model) return
    if (loading) return loading

    loading = (async () => {
      const started = performance.now()
      const variant = await resolve()
      if (!variant) throw new Error('no GLiNER checkpoint is provisioned')

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

      const threaded = isIsolated()

      const build = async (ep: 'wasm' | 'webgpu') => {
        const instance = new Gliner({
          tokenizerPath: variant.modelName,
          // Node takes only a path; the web build also wants an execution
          // provider and is worth letting use more than one thread.
          onnxSettings: isNode
            ? { modelPath: variant.modelFile }
            : {
                modelPath: variant.modelFile,
                executionProvider: ep,
                // Explicit, because gliner's default is a jsDelivr CDN URL and
                // a scan must never depend on a third party being reachable.
                wasmPaths: config.wasmPaths,
                // Only where the context can actually provide them. Hardcoded
                // `true` is what makes a non-isolated context hang instead of
                // simply running slower.
                multiThread: threaded,
              },
          maxWidth: config.maxWidth,
          modelType: 'span-level',
          transformersSettings: {
            allowLocalModels: true,
            useBrowserCache: !isNode,
          },
        })
        await instance.initialize()
        return instance
      }

      /**
       * What to try, in order.
       *
       * A host that named a provider gets that one and nothing else — the
       * extension bundles only WASM, and quietly starting something it did not
       * ship would be worse than failing. Otherwise WebGPU first, because it
       * moves the one-off startup from seconds to under a second, then WASM,
       * which every browser has.
       *
       * The fallback exists because the alternative is what happened before:
       * one unavailable backend meant no model at all, silently, on every
       * escalation. A slower backend is a far better answer than none.
       */
      const wanted: Array<'wasm' | 'webgpu'> = config.executionProvider
        ? [config.executionProvider]
        : hasWebGPU()
          ? ['webgpu', 'wasm']
          : ['wasm']

      let instance: Awaited<ReturnType<typeof build>> | null = null
      let firstFailure: unknown = null
      for (const ep of isNode ? (['wasm'] as const) : wanted) {
        try {
          instance = await build(ep)
          // Reported truthfully, including the thread count: a run labelled
          // `wasm-threaded` that was actually single-threaded would make the
          // whole WASM-versus-WebGPU comparison worthless.
          provider = isNode
            ? 'none'
            : ep === 'webgpu'
              ? 'webgpu'
              : threaded
                ? 'wasm-threaded'
                : 'wasm-single'
          break
        } catch (cause) {
          firstFailure ??= cause
          console.warn(
            `[ai-safe] the ${ep} backend did not start; ` +
              `${ep === wanted[wanted.length - 1] ? 'no backend left to try' : 'trying the next one'}.`,
            cause,
          )
        }
      }
      if (!instance) throw firstFailure ?? new Error('no ONNX backend started')

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
        // Non-zero before resolution: the escalation gate reads `bytes === 0`
        // as "free to run, never gate it", and a confirmer with weights must
        // not look free just because nobody has asked where it lives yet.
        bytes: resolved?.bytes ?? VARIANTS[VARIANTS.length - 1].bytes,
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
    /**
     * The backend that actually started.
     *
     * Reported rather than assumed: this was never populated, so every
     * envelope said `ep: 'none'` even when the model was running — and `ep`
     * exists precisely to answer whether WebGPU is worth its bundle size.
     */
    get runtime() {
      return { ep: provider, labelCount: Object.keys(config.labels).length }
    },
  }
}
