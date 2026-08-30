# AI Safe — local prompt sanitizer

Check anything for personal, internal or secret information **before** you paste
it into ChatGPT, Copilot or Gemini.

Paste text or drop a file → see what is risky → clean it in one click → improve
the prompt → copy or download the result. The whole thing runs inside the
browser tab.

```
Paste / Drop  →  Check  →  Understand  →  Clean  →  Improve  →  Copy / Export
```

📐 **Architecture & data flow** — a visual walkthrough of the pipeline: what each
layer proposes, where the confidence engine decides, the escalation gate, and
where the local model sits. Open [`docs/architecture.html`](docs/architecture.html)
in a browser (no build step, no dependencies), or view the
[hosted copy](https://claude.ai/code/artifact/ffdbd76d-12b4-4a31-82c2-324a50deb310)
if you have access.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

Then click **Try an example**, or drag one of the files in `samples/` onto the
page.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check and produce a static `dist/` |
| `npm test` | 131 tests: detection, false positives, classification, document sensitivity, escalation, sanitization, documents, performance |
| `npm run check` | Type-check, lint, test, and score the corpus and the sample files |
| `npm run check:corpus` | Score the labelled corpus and print every false positive and false negative |
| `npm run check:heldout -- bench/heldout-ambiguity-2.json` | Score a held-out ambiguity set the engine was **not** tuned against. Add `--gliner` to score it with the model |
| `npm run provision:model` | Download the GLiNER weights once (~183 MB) into `public/models/` |
| `npm run check:perf` | Per-layer and end-to-end latency, plus whether the confirmer was invoked |
| `npm run check:engine` | Print what the detector finds on the demo prompt, in all three cleaning modes |
| `npm run check:files` | Round-trip every sample file: extract → scan → clean → re-open the cleaned copy → re-scan for leaks |
| `npm run samples` | Regenerate the demo files in `samples/` |

## Why the privacy claim holds

The app is a static front end with no back end. **Your content never leaves the
machine**, because there is no server to send it to. File parsing, detection,
sanitization, classification and prompt improvement are all plain TypeScript
running in the tab, and nothing is written to disk or to `localStorage`.

Being precise about the network, since a model does now run:

- **No third-party request is ever made at scan time.** Nothing is sent to
  HuggingFace, to an API, or anywhere else.
- **The only request the app makes** is for its own model weights, from its own
  origin (`/models/…`), and only when a scan actually escalates. Those files
  were downloaded once at install time by `npm run provision:model`. Serve the
  app offline and it keeps working.
- **No cloud model for detection.** Sending your text to an API to find the PII
  in it would leak exactly what the tool exists to protect.
- **No cloud model for prompt improvement either.** The improver is
  rule-based, so it is instant, predictable in a demo, and has nowhere to send
  anything. It only ever sees the *sanitized* text — the original is not passed
  to it.

You can verify all of this in the browser's network tab: scan a document and
watch for requests leaving the origin.

## How detection works

Three independent layers run over the text and their results are merged, so no
single technique is load-bearing.

| Layer | File | What it catches |
| --- | --- | --- |
| 1 — deterministic rules | `src/engine/detectors/patterns.ts` | Emails, phone numbers, IPs, MACs, URLs, UUIDs, card numbers (Luhn-checked), IBANs, ID numbers, AWS / GitHub / Slack / Google / Stripe / model-provider keys, JWTs, bearer tokens, PEM private keys, connection strings, `password = …` assignments |
| 2a — candidate generation | `src/engine/detectors/entities.ts` | Proposes people, companies, places and street addresses |
| 2b — **context and confidence** | `src/engine/context.ts` | Decides whether the surrounding language actually supports each candidate |
| 3 — business patterns | `src/engine/detectors/business.ts` | Internal server and domain names, network shares, customer / case / contract / employee numbers, licence keys |
| 3b — company confidential | `src/engine/detectors/confidential.ts` | Internal project names, unreleased release dates, pricing and margin terms |

Layers 1, 2a, 3 and 3b only ever *propose*. They emit a `Candidate` with a
`base` score reflecting what the gazetteers and regexes know, and nothing else.
Layer 2b decides. That separation is what makes the engine testable: candidate
generation and judgement can be wrong independently.

Layer 2a is a compact gazetteer plus shape recognition rather than a neural NER
model, because it has to run over every candidate in the document. The neural
model sits behind the gate instead, checking only what the rules could not
settle — see [the GLiNER confirmer](#the-gliner-confirmer). Detectors are
registered in `src/engine/detect.ts` behind a one-function `Detector`
interface, so another layer can be added without touching anything else.

Overlapping claims are resolved by category priority, then match length, then
confidence — so `4111 1111 1111 1111` is a card number rather than a phone
number, and `\\BKP-REPO-01\archive` is one network path rather than two
hostnames. Resolution uses a claimed-character bitmap, so it stays linear in
total match length rather than quadratic in candidate count.

## Confidence: how false positives are reduced

The old engine was binary — a gazetteer hit was a finding. That produced two
problems at once: it flagged "Christian values are important" as a person, and
it blanket-ignored every sentence-initial single name, so it *missed*
"Christian joined the meeting". Precision and recall were both being paid for
by the same crude rule.

Layer 2b replaces it with weighted evidence, and it deliberately looks for
evidence in **both** directions:

| | Example signals |
| --- | --- |
| **For** | a title before it; a cue word ("contact", "regards"); a following person-verb ("joined", "approved"); a role or department after it; possessive `'s`; a job title; the same name appearing in an email address in the same content |
| **Against** | the word is also everyday English ("Grace", "May", "Frank"); a determiner before it ("the May release"); a common noun after it ("Christian **values**"); a function word after it ("Mark **the** invoice"); the same word used in lower case elsewhere in the document; capitalised only because it starts a sentence |

Each signal carries a weight and a plain-English note. The notes are not
decoration — they are what the UI shows under an uncertain finding, so the
explanation and the score can never drift apart.

Three tiers follow from the total (`src/engine/context.ts`):

| Tier | Meaning | Behaviour |
| --- | --- | --- |
| **high** (≥ 0.80) | strong evidence | accepted, shown as "Certain" |
| **medium** (≥ 0.55) | genuinely ambiguous | accepted but shown as "Possible", and eligible for a second opinion |
| **low** (< 0.55) | not enough evidence | discarded — never shown, never sanitized |

Two further passes matter:

- **Entity consistency.** If one mention of a value is confident, other
  mentions of the same value inherit some of that confidence. "Sarah Mitchell
  raised the case… later Sarah asked for an update" resolves both.
- **Recall, not just precision.** A capitalised word no gazetteer recognises
  used to be dropped silently, which is a false negative no amount of tuning
  could fix. It is now a candidate with a low base that only survives if
  context carries it — so `Adeyemi confirmed the migration window` is found
  without `Adeyemi` appearing in any word list.

### Measured

`npm run check:corpus` scores the in-repo corpus; `npm run check:heldout`
scores sets the engine was not tuned against.

| | Before | After |
| --- | --- | --- |
| False positives (50 traps) | 4 | **0** |
| False negatives (28 expected) | 6 | **0** |
| Held-out ambiguity set, F1 | 50.0% | **95.2%** |
| Held-out recall | 36.4% | **90.9%** |

The held-out number is the honest one. The in-repo corpus was written
alongside the engine, and scoring 100% on your own examples proves little — on
first contact with held-out data the engine scored 66.7%, which is how the
double-penalty bug behind that gap was found.

## Selective confirmation

Ambiguous findings — and only ambiguous findings — can be escalated for a
second opinion. The seam is `LocalModelDetector`
(`src/engine/confirm/types.ts`): anything that can look at one candidate in a
small window of text and say "person" or "not a person" can be registered with
`registerLocalModel()`, and nothing else in the engine knows which
implementation is installed.

The gate is the important part:

```
scan()                     synchronous, no model, never escalates
scanWithConfirmation()     escalates only if ambiguous.length > 0
```

Measured on this machine (`npm run check:perf`):

| Workload | Ambiguous | Model invoked | Confirm cost |
| --- | --- | --- | --- |
| short prompt | 0 | **no** | 0.00 ms |
| realistic prompt | 0 | **no** | 0.00 ms |
| 291 KB document, 8 100 findings | 0 | **no** | 0.00 ms |
| deliberately ambiguous text | 3 | yes | 1.1 ms |

The confirmer is never constructed, loaded or called when the fast path already
reached a confident conclusion. When it is called it receives a ~320-character
window per candidate, never the document.

Failure is never fatal. If the confirmer reports itself unavailable, throws
during load, or throws during inference, the fast-path findings are returned
unchanged and the reason is recorded in `escalation.error`. Four tests in
`src/engine/__tests__/escalation.test.ts` cover exactly those paths.

The confirmer that ships is `deep-context`: a deterministic pass that examines
*every* occurrence of the value in the window and votes across them, reads the
whole clause rather than the adjacent word, and looks for pronoun and job-role
agreement. It needs no files, cannot fail to load, and would be wasteful to run
over every candidate in a large document — which is precisely why it sits
behind the gate.

### The GLiNER confirmer

The confirmer that runs is **GLiNER small v2.1** (int8 ONNX, ~183 MB),
registered in `src/main.tsx`. It checks the rules' work in both directions:

- **False positives** — an ambiguous call the rules could not stand behind is
  re-examined. `Hyundai reported record sales` was flagged as a person by the
  rules; GLiNER relabels it as an organisation.
- **False negatives** — a capitalised word no gazetteer contains
  (`Aarav Krishnamurthy`) is promoted if GLiNER recognises it. This is the half
  a confirmation-only gate could never do, and it needed the recall path below.

Both come from one pass: GLiNER returns spans with character offsets, so a
single inference per window adjudicates the candidates inside it *and* surfaces
what was missed.

```bash
npm run provision:model    # ~183 MB into public/models/, once
```

The weights are git-ignored and served from the app's own origin. Nothing is
fetched from a third party during a scan. **If they were never provisioned the
app still works** — the engine falls back to the deterministic deep-context
pass and records why.

#### What it is allowed to do

| | |
| --- | --- |
| **Confirm** a finding | yes — promotes it to high confidence |
| **Relabel** a finding | yes — the rules guess a category from shape, GLiNER knows `Nokia Bell Labs` is an organisation |
| **Recover** a candidate the rules scored too low to show | yes |
| **Discover** an entity nobody proposed | yes, if capitalised and outside a span the rules already declined |
| **Delete** a finding the rules affirmatively called | **no** |

That last row is the important one. The confirmer sees a few hundred
characters; the rules saw the whole document, and their evidence — a role cue,
a title, a matching email address — is often outside that window. When the two
disagree the failure modes are not symmetric: an unnecessary redaction is an
annoyance, a deleted finding is a leak. So a rejection downgrades a finding to
"still uncertain" rather than removing it. Rejection does its job on recovery
candidates, where the rules had no opinion and "reject" simply means "do not
promote".

#### The gate

| Situation | Model loads? |
| --- | --- |
| Nothing ambiguous | **no** |
| Only unknown words to speculate about, model cold | **no** |
| Something genuinely ambiguous | yes |
| Unknown words, model already resident | yes — marginal cost is milliseconds |

Loading 183 MB to speculate about a capitalised word is the wrong trade; an
ambiguous finding means the rules reached a conclusion they could not stand
behind, and that earns it.

#### Measured

| | Rules only | With GLiNER |
| --- | --- | --- |
| Held-out set 2, F1 | 95.2% | **100%** |
| Held-out set 1, F1 | 95.7% | 95.2%¹ |
| Cold start (Node) | — | ~1.0 s, once per session |
| Escalating scan, warm | — | ~100–140 ms |
| Per candidate | — | ~8 ms |
| Entry bundle | 156 KB gzip | 158 KB gzip² |

¹ The single difference on set 1 is `Chase from procurement`, which GLiNER
relabels from person to organisation (Chase is also a bank). The value is
**still detected and still redacted** — the label changed, not the outcome. Our
scoring asks "is this a person?", so it counts as a miss; no data leaked.

² All model code is lazily imported, so the entry chunk grows by 2 KB.
`transformers` (192 KB gzip) and the ONNX runtime load only when the model
does.

In the browser the weights are parsed by WebAssembly rather than native code,
so the one-off startup is several seconds rather than one. It happens on the
first scan that escalates and never again in that session — the scan overlay
says so while it waits rather than showing a finished-looking checklist.

Run it yourself: `npm run check:heldout -- bench/heldout-ambiguity-2.json --gliner`

## Company-confidential detection

A Q4 roadmap with no names in it contains no PII and is still the last thing
you want to paste into a chatbot. That is a separate question, so it has a
separate engine (`src/engine/documentSensitivity.ts`) and a separate risk
dimension.

Three states, deliberately conservative: **general**, **possibly internal**,
**potential company confidential**. The strongest wording it ever uses is
"potential", because it cannot know an organisation's real classification
policy.

Signals are combined across four independent families:

- **Explicit markers** — `CONFIDENTIAL`, `INTERNAL USE ONLY`, `DO NOT
  DISTRIBUTE`
- **Semantic topics** — unreleased plans, internal architecture, pricing,
  strategy, internal financials, security architecture, internal process
- **Metadata** — filename, worksheet names, headings
- **Structure** — density of customer/contract identifiers, number of distinct
  companies named, count of lines carrying future quarters

...and pushed back down by contrary evidence: press-release and public-policy
language.

**It cannot be keyword-only, structurally.** Either two independent families
must agree, or one family must fire on three or more distinct terms. So:

| Input | Result |
| --- | --- |
| A document containing only the word `CONFIDENTIAL` | general — one family is never enough |
| A published "Confidentiality Policy" | general — the marker pattern refuses that phrasing, and public-policy language counts against |
| A press release announcing general availability | general — release language, but public markers dominate |
| Q4 roadmap: marker + unreleased plans + pricing | **potential company confidential** |
| An internal HLD with six architecture terms | possibly internal — one emphatic family |

## Classification: what it is, what it's about, whose it is

A fourth question, separate again from PII and from confidentiality. A signed
NDA contains no personal data, is obviously internal, and knowing it is *an NDA
about intellectual property belonging to Legal* is what tells a person how
carefully to treat it.

Three dimensions (`src/engine/classify.ts`, taxonomy in
`src/engine/taxonomy.ts`):

| Dimension | Cardinality | Examples |
| --- | --- | --- |
| **Document type** | one best answer | NDA, MSA, statement of work, contract, invoice, purchase order, quote, meeting notes, policy, design spec, roadmap, report, support case, email, CV, payslip |
| **Topic** | multi-label | Intellectual property, Legal, Sales, Finance, People and HR, IT and security, Procurement, Marketing, Product, Operations |
| **Function** | multi-label | Legal, Sales, Finance, HR, IT, Procurement, Marketing, Engineering, Support, Executive |

Scoring is the same shape as the rest of the engine: canonical signatures carry
most of the weight (`"NON-DISCLOSURE AGREEMENT"` is not ambiguous), supporting
vocabulary contributes in aggregate, the filename is evidence, and neighbouring
classes argue against each other so a statement of work does not simply read as
a contract.

Two inference steps fill gaps that vocabulary alone cannot:

- **Type → topic.** A purchase order is *about* procurement but never uses the
  word — it says "ship to", "requisition", "buyer". When no subject vocabulary
  is found, the document type implies it.
- **Topic → function.** When nobody names a department, the subject attributes
  it.

Both are marked `inferred` and carry lower confidence, and the UI marks an
inferred function with a `?`.

Classification also feeds the sensitivity engine as its own signal family: a
confidently identified NDA, contract, SOW, quote, payslip or CV is internal by
nature, whatever words it happens to use.

### Why no zero-shot classifier ships

Benchmarked, not assumed — `bench/bench-zeroshot.mjs` runs
**DeBERTa-v3-small NLI (int8 ONNX)** over the same held-out set as
`npm run check:classify`:

| | Deterministic | Zero-shot DeBERTa-v3-small |
| --- | --- | --- |
| Document type | **12/12 (100%)** | 6/12 (50%) |
| Topic | 12/12 (100%)¹ | 5/12 (41.7%) |
| Latency | **0.43 ms** per document | 384 ms per document |
| Provisioned | 0 | 188 MB |
| Resident memory | ~45 MB total | **+828 MB** |

¹ Honest caveat: the document-type figure was genuinely held out. The topic
figure was **41.7% on first contact** — the type → topic inference above was
added after seeing those results, so 100% on this set is no longer a held-out
number. Write a fresh set before trusting it.

The zero-shot result was swept across decision thresholds (0.30 / 0.35 / 0.40)
to give the model its best shot, since the deterministic engine is tuned; it
peaked at 50% / 41.7%.

Why it loses so badly here: document types **announce themselves**. A contract
opens "This Agreement is entered into"; an invoice says "Invoice Number". That
is precisely the case where a regex beats a language model, and it is most of
this problem. The cost multiplier makes it worse — NLI zero-shot needs one
forward pass **per candidate label**, so 16 types + 10 topics is 26 passes per
document.

What this does **not** settle: the larger models (`bart-large-mnli`,
`deberta-v3-large-zeroshot-v2.0`) would likely score far better than the small
one — published figures suggest 88–92%. They are 410 MB+ quantized and would
push a browser tab past a gigabyte resident, and they would still be competing
with 100% on document type. The open question is **topic on documents whose
type is unclear**, where the inference chain has nothing to work from; that is
the one place a large zero-shot model might genuinely win. `ClassifierBackend`
in `src/engine/classify.ts` is the seam, and `registerClassifier()` is the only
line that needs to run.

### Feedback foundation

The document engine is rule-based because there is no labelled data for *this*
organisation's policy. `src/engine/feedback.ts` is how that data could be
collected: every assessment is recorded in a shape a classifier could train on
— counts, signal ids, topics, and what the user decided.

It stores **no raw content** by default, has no transport of any kind (no
fetch, no storage adapter), lives in memory for the life of the tab, and trains
nothing. `exportDataset()` returns JSON the user could choose to save; that is
the only way anything leaves. No MiniLM or DistilBERT classifier has been
added, deliberately — a generic sensitivity classifier with no representative
training data would produce confident-looking noise.

### Adding a rule

Most additions are data, not code. To teach it your company's ticket format:

```ts
// src/engine/detectors/business.ts
{
  name: 'Support case or ticket number',
  category: 'CASE_ID',
  pattern: /\b(?:CASE|TICKET|TKT|SR|INC)[-_ ]?#?\d{3,10}\b/gi,
  confidence: 0.93,
}
```

A genuinely new *kind* of data also needs an entry in
`src/engine/categories.ts`, which is where the plain-English label, the
placeholder, the severity and the "why we flagged this" sentence live.

## Risk score

Each finding contributes by severity (critical 45, high 18, medium 8, low 2)
weighted by confidence, and the total is mapped through `100 × (1 − e^−x/60)`.
The curve means the first few items move the number a lot and the twentieth
barely does — which matches how a person judges risk, and stops any long
document pinning at 100 forever.

The "after" score is a **real re-scan of the cleaned text**, not a hard-coded
zero. Stand-ins the tool inserted itself are excluded, since flagging its own
placeholder would be noise. If something survives cleaning, the number says so.

## Cleaning modes

| Mode | `john.smith@acme.com` becomes | Use when |
| --- | --- | --- |
| Placeholders | `[EMAIL]` | Clearest for the AI. The default. |
| Nicknames | `Email_001` | The AI needs to track who is who across a long document. |
| Realistic fakes | `alex.taylor@example.com` | The text has to still read naturally. |

Stand-ins are consistent: the same value maps to the same replacement
everywhere. Synthetic values only ever come from ranges reserved for
documentation (`example.com`, `555-01xx`, `203.0.113.0/24`, the `4111…` test
card), so a fake can never collide with something real.

**Secrets are the exception.** Passwords, keys and tokens are removed outright
in every mode — handing back a realistic-looking credential would only invite
somebody to trust it.

## Files

`.txt` `.md` `.log` `.json` `.csv` `.tsv` `.docx` `.xlsx` `.pdf`

The original file is never modified. Downloading a cleaned copy builds a new
document in memory:

- **Excel** — sheets, merged cells, column widths, row heights, cell types and
  number formats are preserved; only sensitive cell values change. Matching
  tries the *formatted* value first (which is what the scanner saw, and what
  the user saw), then the raw one. A replaced cell drops its formula, since a
  formula would simply recompute the value back.

  One subtlety: cells are flattened to text with `" | "` between them for
  scanning, so a match can straddle two cells — a value that exists in the
  flattened text but in no actual cell, and which the writer could therefore
  never remove. Rather than let the UI promise a cleanup that silently fails,
  such findings are discarded (`structuralDelimiter` in `ScanOptions`).
- **Word** — the body, headers, footers, footnotes and endnotes are all
  scanned and rewritten. Word freely splits a sentence across runs (a
  spell-check boundary is enough), so "John Smith" is regularly stored as
  "John Sm" + "ith". Replacement therefore works on the paragraph's
  concatenated text, maps each match back to character ranges, and rebuilds
  each run individually: text outside a match keeps its own formatting, the
  replacement is emitted in the run where the match began, and every other run
  in the paragraph is left byte-identical. Bold, italics, sizes, styles,
  tables and section properties all survive — asserted in the tests.
- **PDF** — text is extracted and scanned, and the cleaned copy is delivered as
  `.txt`. Rewriting PDF layout reliably is out of scope.

`npm run check:files` proves the round trip: it re-opens each cleaned file and
re-scans it, and reports any value that leaked.

## Project layout

```
src/
  engine/                  pure, dependency-free, no I/O
    categories.ts          every category: label, severity, placeholder, why
    detect.ts              pipeline: candidates -> context -> tiers -> findings
    context.ts             the confidence engine (positive + negative context)
    lexicon.ts             contextual vocabulary: ambiguity, verbs, topics
    gazetteer.ts           name, place, org and infrastructure word lists
    documentSensitivity.ts document-level company-confidential assessment
    feedback.ts            local-only dataset foundation, no transport
    risk.ts                scoring
    sanitize.ts            redact / pseudonymize / synthetic
    improve.ts             local rule-based prompt rewriting
    detectors/             layers 1, 2a, 3, 3b — all propose, none decide
    confirm/               the escalation seam + the shipped confirmer
    __tests__/             corpus + detection, document, escalation, perf tests
  files/                   extraction and cleaned-file writing
    __tests__/             generated Office fixtures + round-trip tests
  components/              UI (shadcn/ui + Tailwind v4)
scripts/                   scoring, benchmarking and sample generation
bench/                     GLiNER benchmark + held-out ambiguity sets
samples/                   fictional demo files — drag these onto the app
```

`src/engine` has no browser or React dependencies, which is why the same code
runs unchanged in the Node smoke tests.

## Demo data

Everything in `samples/` and behind **Try an example** is invented: made-up
names, `example.com` addresses, reserved `555-01xx` phone numbers and a fake
API key. Nothing real is needed to demo the tool.

## Scope

A hackathon MVP, deliberately. No accounts, no server, no database, no policy
administration, and no integrations with AI providers — the output is text you
paste wherever you like.

### Known limitations

- **A name with no supporting context is still missed.** "Please copy Aarav
  Krishnamurthy on the reply" fails: "copy" is not a person cue and "on" reads
  as a function word. GLiNER gets this right; the deterministic engine does
  not. This is the single held-out failure and it is the honest cost of the
  decision not to ship the model.
- **A company can be mislabelled as a person.** "Hyundai reported record
  sales" reaches the medium tier via the person-verb signal. It is a category
  error rather than a leak — the value still gets sanitized — but the label is
  wrong, and it is shown as "Possible" rather than certain.
- **Document sensitivity cannot know your policy.** It says "potential", never
  "confidential", on purpose. A genuinely confidential document written in
  neutral language will read as general.
- **Excel formulas that reference a sanitized cell keep their cached result.**
  The formula is removed from replaced cells, but a formula elsewhere that
  depended on one will be stale rather than recomputed.
- **Worksheet names are scanned but never renamed**, since renaming a sheet
  breaks every formula that references it.
- **PDF output is text only.** Rewriting PDF layout reliably is out of scope.
- **The in-repo corpus is not an unbiased benchmark.** It was written
  alongside the engine. Use `bench/heldout-ambiguity-2.json` for an honest
  number, and write a fresh set before trusting any future tuning.
