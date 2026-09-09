# AI Safe Console — admin dashboard feature plan

Status: proposal. Nothing here is built yet.

This plan sits on top of the ten-item remediation plan. It adds an eleventh
workstream — a fleet-facing admin console — and, more importantly, it forces a
decision the first ten items let us postpone.

---

## 0. The decision that gates everything

Every claim this project makes rests on one sentence:

> Your content never leaves the machine, because there is no server to send it to.

An admin console showing risk **across users** cannot be built without egress.
Not "should not" — cannot. So the question is not whether to soften the promise;
it is which promise replaces it, stated as precisely as the current one.

The replacement:

> **No prompt content, file content, or matched value ever leaves the device.
> There is no field in the wire format that can carry one.**

That is a different guarantee from "no server", and it is weaker. It is also
verifiable in the same way: read the schema. If the envelope has no string field
that content could hide in, an admin cannot see content even if they modify the
collector, because the extension never produced it.

Three consequences, all of which must be designed for rather than discovered:

1. **A local-only mode has to remain first-class**, not a degraded fallback.
   The console's Phase 0 runs entirely against the on-device IndexedDB ledger
   (item 6) and shows one person their own activity. Zero egress, zero backend,
   and it doubles as the transparency surface that makes fleet mode defensible:
   the user can see exactly what would be reported.
2. **Fleet mode is opt-in at the org level via managed policy** (item 5), never
   a default, and the extension must show a persistent, non-dismissable
   indicator when reporting is on. A safety tool that starts reporting silently
   is spyware with good intentions.
3. **The collector is the org's own infrastructure.** We ship the schema, the
   batching client, and a reference collector; we never host it. "Your data goes
   to your endpoint" is the only version of this that a security team will sign.

---

## 1. The Metadata Ledger — the wire format is the guarantee

One event per interception. No free-text fields, no `text`, no `snippet`, no
`context`. Every field is an enum, a number, a bounded token, or a keyed HMAC.

```ts
// src/telemetry/ledger.ts
export interface LedgerEvent {
  v: 1
  id: string                    // uuid v4, client-generated (idempotency key)
  ts: number                    // epoch ms, rounded down to the minute
  actor: string                 // HMAC-SHA256(orgSalt, stableUserId) — pseudonym
  dept?: string                 // from managed policy, coarse; never free text
  host: string                  // registrable domain only: 'chatgpt.com'
  surface: 'paste' | 'submit' | 'drop' | 'file-input'
  mode: 'enforce-block' | 'enforce-sanitize' | 'observe'
  decision: 'allow' | 'warn' | 'block'
  outcome: 'sent-clean' | 'cleaned-then-sent' | 'sent-anyway' | 'cancelled' | 'held'
  msToResolve?: number          // banner shown -> user acted. Friction metric.

  // Counts only. Keys come from src/engine/categories.ts — never invented here.
  categories: Partial<Record<CategoryId, number>>
  tiers: { high: number; medium: number }

  // From src/engine/classify.ts and documentSensitivity.ts
  docType?: DocumentType
  sensitivity?: 'general' | 'possibly-internal' | 'potential-confidential'

  attachment?: {
    ext: string                 // allowlisted extension token, not a filename
    bytes: number               // bucketed: 2^n
    pages?: number
    extracted: boolean          // did extract.ts understand it at all
  }

  // Recurrence detection. Gated — see §2. Empty for low-entropy values.
  fingerprints: string[]        // HMAC-SHA256(orgSalt, normalizedValue)

  account: 'company' | 'personal' | 'unknown'
  sanctioned: 'sanctioned' | 'shadow' | 'unknown'

  engine: {
    version: string
    confirmedBy: 'gliner' | 'deep-context' | 'none'
    escalated: boolean
    ms: number
    error?: 'model-unavailable' | 'model-threw' | 'engine-unreachable'
  }
  adapter: { id: string; composerFound: boolean; sendFound: boolean }
  client: { extVersion: string; browser: 'chrome' | 'edge' | 'firefox'; os: string }
}
```

Design notes that are load-bearing:

- **`host` is the registrable domain, not the URL.** A full URL is content —
  `?q=our+acquisition+of+Foo` leaks the thing we are protecting. Strip to eTLD+1
  via a bundled public-suffix list; never `location.href`.
- **`ts` rounded to the minute.** Millisecond timestamps across a small
  department are a re-identification vector even with a pseudonymous actor.
- **`bytes` bucketed to powers of two.** An exact byte length is a fingerprint of
  a specific document.
- **`actor` is an HMAC under an org-held salt**, so it is stable enough for
  "same person again" and useless outside the org. Rotating the salt is the
  org's forget-me button: rotate, and every prior event becomes unlinkable.
- **`CategoryId` and `DocumentType` are imported from the engine**, not
  re-declared. A parallel vocabulary in the telemetry layer will drift from
  `categories.ts` within one sprint. (Same objection applies to
  `BlockedCategories` in the managed schema — see §10.)

---

## 2. Fingerprints need an entropy gate — and it is item 10's function

`fingerprints` is the most valuable field on the envelope and the most dangerous.

Valuable: the same HMAC appearing 14 times across 6 users and 3 tools means **one
credential is circulating**, and that is actionable with zero content.

Dangerous: `HMAC(salt, "Ian Engelbrecht")` is trivially reversed by an admin who
holds the salt and a list of 30,000 employee names. For low-entropy values, an
HMAC is not a redaction — it is a lookup key.

So fingerprinting is gated on the *value's own entropy*, using exactly the
function item 10 introduces:

```ts
const FINGERPRINT_MIN_BITS = 48   // total, not per-char

export function mayFingerprint(value: string): boolean {
  const perChar = calculateShannonEntropy(value)   // from src/engine/layers/secrets.ts
  return perChar * value.length >= FINGERPRINT_MIN_BITS
}
```

Consequence: secrets, keys, tokens, account numbers and long identifiers get
fingerprinted. Names, emails, phone numbers and addresses never do — they exist
in the ledger only as counts. That falls out of one shared function rather than
a policy document, which is the only kind of guarantee that survives contact
with a deadline.

---

## 3. Aggregation guardrails, visible in the product

The console is an employee-monitoring surface whether we intend it or not. The
guardrails are features, not disclaimers, and they are on screen:

| Guardrail | Default | Rationale |
|---|---|---|
| k-anonymity suppression | k = 5 | Any cell backed by fewer than 5 distinct actors renders `<5`, not a number |
| Per-actor drill-down | **off** | Requires a second admin to enable (dual control) and is time-boxed |
| Console's own audit trail | always on | Every drill-down, export and policy change is itself logged and shown |
| Retention | 90 days | Enforced client-side too: the extension drops un-sent events past the window |
| Salt rotation | manual, one click | The forget-me mechanism |
| "What is collected" | linked from every screen | Renders the live schema, not prose about it |

A persistent header chip states the posture: **Aggregates only · k≥5 · no content
collected · [view schema]**. Making the privacy posture a first-class UI element
is both correct and the single best sales asset the product has.

---

## 4. Architecture — one seam, two sources

Follow the pattern the codebase already uses for `LocalModelDetector` and
`ClassifierBackend`: define the interface, let the implementation be swappable,
and let nothing upstream know which is installed.

```ts
// src/console/source.ts
export interface MetricsSource {
  id: 'local' | 'fleet' | 'demo'
  scope(): Promise<{ actors: number; depts: string[]; k: number }>
  query<T extends QueryName>(name: T, params: QueryParams[T]): Promise<QueryResult[T]>
  capabilities(): { perActorDrilldown: boolean; policyWriteback: boolean }
}
```

```
┌─────────────────────────────────────────────────────────────────┐
│                    Console UI (shadcn, React)                   │
│         panels are written against MetricsSource only           │
└───────────────────────────────┬─────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐     ┌──────────────────┐    ┌──────────────────┐
│ LocalSource   │     │ FleetSource      │    │ DemoSource       │
│ IndexedDB     │     │ org collector    │    │ seeded generator │
│ (item 6)      │     │ HTTPS + batching │    │ 90d, plausible   │
│ 1 actor, k=1  │     │ n actors, k>=5   │    │ for design + demo│
│ zero egress   │     │ opt-in, managed  │    │ zero egress      │
└───────────────┘     └──────────────────┘    └──────────────────┘
```

`DemoSource` is not a nice-to-have. Without it the console cannot be designed
(every panel is an empty state on day one) and cannot be demoed. It generates a
plausible 90-day ledger from a fixed seed — the same trick `src/demo/samples.ts`
already plays for the scanner.

Where it lives: a route in the existing Vite app (`/console`) for Phases 0–1,
because the app already carries shadcn, the theme, and the engine types. Split
into its own package only when a collector exists.

---

## 5. The screens

| # | Screen | Answers |
|---|---|---|
| 1 | **Overview** | Is anything on fire this week? |
| 2 | **Shadow AI** | What AI are people using that we did not sanction? |
| 3 | **Accounts** | Who is on a personal login on a sanctioned tool? |
| 4 | **Tool sprawl** | How many tools do the same job? |
| 5 | **Data at risk** | What kinds of data get pasted, and what got stopped? |
| 6 | **Attachments** | What documents were people about to upload? |
| 7 | **Interventions** | Does the warning actually change behaviour? |
| 8 | **Coverage & health** | Is the protection actually working out there? |
| 9 | **Recurring secrets** | Is one credential circulating? |
| 10 | **Policy studio** | What happens if we tighten this? |
| 11 | **Audit & export** | Prove it, and get it into the SIEM. |

### 1. Overview

Lead with a **hero figure of near-misses**, not an abstract risk index — a
security lead can repeat "3 credentials and 2 payslips stopped this week" in a
meeting; they cannot repeat "risk score 62".

- Hero figure + KPI row of stat tiles (prompts checked, warned, blocked, cleaned,
  shadow tools seen) — each with delta vs previous period and a sparkline.
- **Decision mix over time** — stacked bar, 3 categorical slots.
- **Department comparison** — bar with *emphasis*: the worst department in the
  accent hue, the rest in de-emphasis gray. Not eight colors.
- Amber **degradation banner** when coverage/health has an open incident.

### 2. Shadow AI — the discovery funnel that writes policy back

The genuinely new capability. The extension already knows every host it runs on;
the console turns that into an inventory nobody has today.

```
NEW DOMAIN SEEN ──▶ USERS ──▶ PROMPTS ──▶ RISK ──▶ VERDICT
 first-seen date    distinct   volume      warn/block   [Sanction] [Block] [Watch]
                    actors                 rate              │
                                                             ▼
                                            emits a managed-policy patch
```

Each newly-observed AI host arrives as a card: *first seen 4 days ago · 12 users
· 3 blocked credentials · unsanctioned*. Three buttons — **Sanction**, **Block**,
**Watch** — each of which generates the `chrome.storage.managed` patch (item 5)
and stages it in Policy Studio.

That write-back is what separates a product from a poster. A console that only
reports gets opened twice.

Classification of "shadow" needs care and should be explicit rather than clever:
a bundled seed list of known AI hosts (~200 entries, versioned, updatable via
managed policy) crossed with the org's sanctioned list. Everything else is
`unknown` and surfaces in a **"Unclassified hosts"** queue for the admin to
label — honest, and it makes the seed list improve with use.

**Risk quadrant** — adoption (x, distinct actors) against risk (y, warn+block
rate), with quadrant labels: *Sanction* (high adoption, low risk), *Investigate*
(high, high), *Ignore* (low, low), *Shut down* (low adoption, high risk). One of
the few places a scatter genuinely beats a table.

### 3. Accounts — the personal-login problem

The strongest finding this product can surface: **usage of a sanctioned tool
under a personal account is outside the enterprise agreement, outside the DPA,
and usually training the model.**

Detection, and its honest limits. Add an optional adapter field:

```ts
{ id: 'chatgpt', label: 'ChatGPT',
  sendSelectors: ['#composer-submit-button'],
  accountProbe: { selectors: ['[data-testid="profile-button"] [title*="@"]'] } }
```

The probe reads a visible account email **already rendered on the page**,
extracts only the domain, compares it against the managed company-domain list,
and reports the enum `company | personal | unknown`. The email itself is never
stored, never hashed, never transmitted — the probe returns three bits, not a
string. Where no probe exists or nothing matches, the answer is `unknown`, and
`unknown` is shown as `unknown` rather than assumed innocent.

This is the most fragile signal in the system (it depends on a profile-menu DOM)
and it must degrade to `unknown` loudly, which is what Coverage & Health is for.

Panel: horizontal stacked bar per tool — company / personal / unknown, with
`unknown` in muted gray rather than a third hue, because it is an absence of
information, not a third category of equal standing.

### 4. Tool sprawl — the capability overlap matrix

Rows are the AI tools actually observed; columns are capability tags (chat, code,
image, transcription, search, agents, meeting notes); cells are distinct users.
A heatmap makes "we are paying for four code assistants and two of them have
nine users between them" visible in one glance.

Beside it, a **consolidation candidates** list: tool clusters sharing a
capability tag, ranked by redundant user-count, with the seat-cost column left
for the admin to fill in (we do not know their contracts and should not pretend
to).

### 5. Data at risk

There are 30+ categories in `categories.ts`. That is past the point where color
carries meaning, so this is a **table with inline meters**, sorted by weighted
volume, grouped by the four policy groups — not a chart with thirty hues.

Above it, one small **part-to-whole stacked bar** at group level only: secret /
personal / confidential / internal. Four slots, direct-labeled.

### 6. Attachments — what the file interceptor stopped

This is where item 1 pays off visibly, and it is the most quotable screen in the
product. Because `classify.ts` runs on extracted text, the console can report
document *types*: "this week the extension stopped 4 payslips, 2 NDAs, a pricing
model and 11 support-case exports from being uploaded to Perplexity."

- Horizontal bar of document types, sequential ramp, ordered by count.
- Sensitivity split (general / possibly-internal / potential-confidential).
- An `extracted: false` counter — files we could not parse and therefore could
  not check. That number belongs on screen, because it is the honest edge of the
  protection and it is exactly where someone will route around the tool.

### 7. Interventions — does the warning work?

The ROI screen, and the one that tells us whether the product is any good.

- **Funnel**: warned → cleaned → sent anyway → cancelled. Ordinal ramp.
- **Sent-anyway rate over time.** If it climbs, the tool is becoming wallpaper.
- **Time-to-resolve histogram** (`msToResolve`). Rising p50 means friction.
- **Sent-anyway by category** — where the policy disagrees with the work. If
  everyone overrides `INTERNAL_HOSTNAME`, the rule is wrong, not the users.

That last panel is the feedback loop `feedback.ts` was built for, finally
closed: the console shows which rules people reject, and Policy Studio lets them
be retuned.

### 8. Coverage & health — turning silent failure into an alert

The failure mode nobody instruments: an adapter stops matching after a site
redesign and the extension quietly protects nothing. The README already admits
the bench cannot catch this. The fleet can.

Status cards, icon + label, never color alone:

> **Protection degraded — gemini.google.com**
> Composer not found for 41 of 44 users since 3 Sep. Adapter `gemini` likely
> broken by a DOM change. Paste protection still active via the generic path;
> submit interception is not running.

Also here: extension version skew, model-provisioning state (how many clients
ever got GLiNER weights — the thing item 2 fixes), clients stuck in
`observe` mode, and `engine.error` rates by type.

### 9. Recurring secrets

Table, driven purely by fingerprint recurrence:

> `a3f9…` · 14 occurrences · 6 actors · 3 tools · first seen 22 Aug · category
> `AWS_ACCESS_KEY` → **rotate**

No content, high value, and it is the panel that most clearly demonstrates the
entropy gate doing its job: names never appear here, by construction.

### 10. Policy studio — the what-if simulator

Because the ledger stores per-event category counts and tiers, the console can
replay history against a *hypothetical* policy without any new data:

> Switching `personal` from **warn** to **block** would have stopped **312**
> sends last month, of which **287** were cleaned anyway. Net new blocks: **25**.

- **Dumbbell chart** — before → after per policy group. Exactly the job dumbbells
  are for.
- Managed-policy generator: emits the `managed_schema.json` payload, plus the
  Windows GPO `.admx` snippet and the macOS `.mobileconfig`, ready to hand to
  whoever runs MDM.
- Staged changes with a diff view and a rollout note.

### 11. Audit & export

- **OCSF** as primary (it has a proper Data Security Finding class and Sentinel,
  Splunk and Chronicle all ingest it). SARIF as a secondary export — it is a
  static-analysis format with no natural place for a host or an actor, so it
  fits awkwardly. CSV for the spreadsheet path.
- Signed export (Ed25519, key from managed policy) so a report is tamper-evident.
- The console's own audit trail, on screen.

---

## 6. Visual system

Existing components in `src/components/ui/`: accordion, alert, badge, button,
card, dialog, label, progress, scroll-area, separator, sonner, switch, tabs,
textarea, toggle-group, toggle, tooltip.

**To add**: `table` + TanStack Table for the data grids, `chart` (Recharts
wrapper), `select`, `dropdown-menu`, `command` (⌘K jump-to-tool), `popover`,
`sheet` (drill-downs), `sidebar`, `skeleton` (loading, not spinners),
`separator` variants, and a date-range control.

Layout: left sidebar nav; sticky top bar carrying the global date range, scope
(org / department), the mode badge, and the privacy chip; 12-column content grid.
Theme via `next-themes`, already a dependency.

### Chart forms, assigned by job

Form is chosen before color, and a few panels resolve to *not a chart*:

| Panel | Form | Color job |
|---|---|---|
| Near-misses this week | hero figure | none |
| KPI row | stat tiles + sparklines | none |
| Decision mix over time | stacked bar | categorical, 3 slots |
| Department comparison | bar, **emphasis** | 1 hue + gray |
| Risk trend | line, single series | 1 hue, no legend |
| Shadow AI quadrant | scatter | see cap below |
| Capability overlap | heatmap | sequential, one hue |
| Account type per tool | horizontal stacked bar | categorical 2 + muted gray |
| Category volume (30+) | **table with inline meters** | sequential |
| Group split (4) | stacked bar, direct-labeled | categorical, 4 slots |
| Document types | horizontal bar | sequential |
| Intervention funnel | funnel | **ordinal** ramp |
| Time-to-resolve | histogram | sequential |
| Policy what-if | **dumbbell** | 1 hue, 2 shades |
| Adapter health | status cards, icon + label | status palette |

Hard constraints carried from the visualization method:

- **No dual-axis chart anywhere.** Two measures of different scale become two
  charts or one indexed to a common base. This is the most tempting mistake on a
  dashboard and the most common.
- **The quadrant scatter caps at three series.** Scatter is an all-pairs form,
  and only the first three categorical slots clear the all-pairs gates
  (`#2a78d6`, `#eb6834`, `#1baf7a` — validated: worst all-pairs CVD ΔE 9.2,
  normal-vision ΔE 24.0). Verdict is therefore encoded with the *status* palette
  plus an icon, and the tool identity comes from direct labels on the top N, not
  from a fourth hue.
- **Status colors are reserved.** good `#0ca30c`, warning `#fab219`, serious
  `#ec835a`, critical `#d03b3b` — never reused as a series color, always shipped
  with an icon and a label, because warning and serious sit below 3:1 on the
  light surface by design.
- **`unknown` is muted gray**, never a hue. It is missing information.
- Every chart gets a hover layer and a table view; ≥2 series always carries a
  legend; ≤4 series are also direct-labeled so identity is never color-alone.
- Dark mode is a *selected* set of steps against the dark surface, not an
  automatic inversion.

Full palette values and the validator: the visualization reference palette.
Run the validator against our own surfaces before shipping, not after.

### Empty states

A fresh install has no data, and this is the screen most demos actually hit.
Every panel needs a designed zero state that explains what would appear and how
long until it does — plus a one-click **"Load demo data"** switch to `DemoSource`.

---

## 7. Phasing

| Phase | Scope | Backend | Ships |
|---|---|---|---|
| **0** | `MetricsSource` seam + `LocalSource` over IndexedDB. "My activity" view. | none | with the extension |
| **1** | `DemoSource` + the full console UI built against the seam | none | app route `/console` |
| **2** | Ledger schema, batching client, reference collector, k-anonymity, retention | org-hosted | opt-in via managed policy |
| **3** | Shadow-AI verdicts + Policy Studio write-back to managed policy | org-hosted | — |
| **4** | OCSF/SARIF export, signed reports, SIEM guides | org-hosted | — |

The sequencing point: **Phases 0 and 1 deliver the entire console with zero
backend and zero compromise of the current privacy claim.** The whole thing is
designable, demoable and reviewable before a single byte leaves a device. Do not
build the collector first.

Dependencies on the remediation plan: item 6 (IndexedDB) gates Phase 0. Items 1
(file interception) and 10 (entropy) gate the Attachments and Recurring Secrets
screens. Item 5 (managed policy) gates Phases 2–3. Item 2 (OPFS weights) gates
the model-provisioning panel in Coverage & Health.

---

## 8. Testing

- **Schema conformance**: a test asserting the envelope contains no field of type
  `string` outside a fixed allowlist of enum/token/HMAC fields. This is the
  privacy guarantee, so it gets a test that fails the build.
- **Entropy gate**: property test that no name from the diverse-names corpus ever
  produces a fingerprint, and that every AWS/Stripe/JWT fixture does.
- **k-anonymity**: query tests asserting suppression at k−1 and disclosure at k.
- **URL stripping**: fuzz `location.href` shapes and assert only eTLD+1 survives.
- **Retention**: clock-advance tests on both client drop and collector purge.
- **Demo determinism**: same seed → same ledger, so visual review is stable.

---

## 9. Open questions

1. **Is the personal-account probe acceptable?** It reads an email domain from
   the page. Reporting three bits is defensible; reading the DOM of a profile
   menu will still make some reviewers uncomfortable. Options: ship it off by
   default, or gate it behind managed policy only.
2. **Who holds the org salt?** If the collector holds it, the collector can
   correlate. If the client holds it, rotation is a fleet operation. Probably:
   distributed via managed policy, so the admin holds it and rotation is a policy
   push.
3. **Does `dept` come from managed policy or from the account domain?** Policy is
   cleaner; domain is automatic and leakier.
4. **Anomaly detection on volume** ("this actor pasted 40× their baseline") is
   technically easy and is the point where the tool becomes surveillance. Proposal:
   leave it out of v1 entirely, and say so in the docs.
5. **Firefox has no offscreen API and no `storage.managed` parity.** How much of
   Phases 2–3 is Chrome/Edge-only?

---

## 10. Corrections to the existing remediation plan

Found while reading the sketches. Listed because each one is a real defect rather
than a style preference.

1. **File-input re-dispatch will recurse forever.** The synthetic `change` event
   is tagged `__ai_safe_bypass`, but the capture handler never tests that flag
   (only the `drop` handler does). Add the guard, and prefer a `WeakSet` of
   in-flight nodes over an expando property, which page scripts can read.
2. **`preventDefault()` on `change` does nothing** — `change` is not cancelable.
   The interception rests entirely on `stopImmediatePropagation()`. Worth a
   comment, because it reads as belt-and-braces and is actually load-bearing in
   only one direction.
3. **The synthetic-Enter re-issue contradicts the existing design, and the
   existing design is right.** `adapters.ts` deliberately re-presses the actual
   send control, and its comment explains why: "A synthetic Enter cannot stand in
   for it: implicit form submission is a browser behaviour, not something
   `dispatchEvent` reproduces." Item 9's `reissuedEvent` reintroduces the bug the
   current code avoids. Keep `sendControlFrom` and press the button.
4. **Per-character `normalize('NFKC')` is not NFKC.** Normalization is
   context-dependent across combining sequences — `e` + U+0301 must normalize as
   a unit, and character-at-a-time will never compose it. Segment by grapheme
   cluster (`Intl.Segmenter`) and normalize per cluster.
5. **`Int32Array(len * 2)` can overflow.** NFKC expansion is not bounded by 2×
   (U+FDFD expands to 18 characters). Grow dynamically or size from the
   normalized output.
6. **`projectRange` mis-maps the end offset** when several normalized characters
   came from one raw character. Track a parallel end-map, or store
   `[rawStart, rawEnd)` per normalized index rather than a single index.
7. **`SubtleCrypto` cannot hash incrementally**, so the "validate SHA-256
   incrementally" box in the model-lifecycle diagram is not implementable as
   drawn. Current sketch also holds ~550 MB peak (chunks + concatenated buffer +
   digest). Either stream to OPFS and then hash by chunked reads with a small JS
   SHA-256, or accept a single-shot digest and document the memory spike.
   `SyncAccessHandle` in the diagram is worker-only; `createWritable()` is the
   right API in the offscreen document.
8. **The entropy floors are mathematically unreachable at short lengths.** Shannon
   entropy per character cannot exceed `log2(len)`. A 16-character string caps at
   4.0 bits/char, so `validateGenericSecretAssignment`'s `entropy >= 4.5`
   fallback rejects every string shorter than ~23 characters — including its own
   `length >= 16` gate. `validateStripeKey`'s `>= 4.0` on a 24-character payload
   caps at 4.58 and will reject valid keys. Normalize instead:
   `H / log2(min(len, alphabetSize))`, and set floors on that ratio.
9. **`AllowlistManager.shouldSuppress` cannot work as shaped** — hashing is async,
   `detect()` is synchronous, and the method returns `false`. More fundamentally,
   hashing the user's own name and email protects against nothing: it is already
   in their browser profile a hundred times over. Recommendation: store the
   allowlist as plaintext in extension-local storage (synchronous, simple,
   honest) and hash only on the *export* path, where a shared audit file is the
   actual threat.
10. **Managed-schema vocabulary duplicates the engine's.** `BlockedCategories`
    re-declares what `categories.ts` already groups, and `ExecutionMode`
    parallels the existing `Policy` interface. Derive both from the engine types
    so they cannot drift.
11. **The synthetic corpus is ~45 cases across 5 frames** — barely larger than the
    48 it replaces, and every case shares syntax, so a grid search will overfit to
    template shape. Needs frames in the hundreds, generated combinatorially over
    (frame × entity × surrounding context × casing × sentence position), and
    split **by frame family** rather than randomly, so the score measures
    generalization to unseen syntax rather than to unseen names.
12. **`document.execCommand('insertText')` is an improvement** over the current
    `element.textContent = text` in `adapters.ts`, which breaks Lexical and
    ProseMirror. Worth promoting into the existing adapter rather than leaving it
    in the new interceptor only.

---

## 11. Performance workstream — the neural gate's latency budget

Four levers: cut the compute, get off the main thread, run fewer inferences, and
spend the latency where nobody is waiting. Most of the proposal below is right
and should be adopted. Three parts need amending because they trade away
capabilities or promises the product has already made, and two of the largest
wins are missing.

### 11.1 There is no single budget — there are four surfaces

Quoting one number ("250 ms") hides the fact that the acceptable delay differs
by an order of magnitude depending on where the model runs:

| Surface | Who is waiting | Warm budget | Cold budget |
|---|---|---|---|
| Extension, **submit** held | the user, mid-send | **150 ms** | never — fall back |
| Extension, **stage two** behind a banner | nobody; banner is already actionable | 2 s | 8 s |
| Web app, **scan overlay** | the user, watching a progress surface | 500 ms | 10 s, with honest copy |
| Web app, **file scan** | the user, after a drop | 1 s | 10 s |

Only the first row justifies a hard race-and-abandon. The second row — which is
where the extension's GLiNER path actually lives — has a generous budget by
design, because the banner is complete before stage two starts. Applying a
250 ms guillotine there would throw away correct answers for no perceptible gain.

**Cold start gets its own budget in every row.** The documented in-browser cold
start is several seconds (WASM parses the weights), so a warm-path budget applied
cold means the model never runs at all on the first escalation of every session —
which is precisely the escalation most likely to matter.

### 11.2 Adopt as written

- **Fixed sequence buckets (64 / 128).** The existing confirmer window is ~320
  characters, so it already fits one 128-token bucket. This is nearly free to add
  and removes per-call tensor reallocation.
- **Eager pre-warm on idle.** `requestIdleCallback` in the offscreen document,
  one dummy token, on tab focus. Turns a first-use spike into background work.
  Guard it behind the same gate logic — pre-warm only on hosts where an adapter
  matched, not on every page.
- **Transferables for the message boundary.** Correct, though the payloads here
  are ~320-character windows; the win is real but small until batching (11.5)
  makes the buffers big enough to matter.
- **LRU window cache** — with three fixes:
  - Key on a **synchronous** non-crypto hash (FNV-1a / xxhash), not
    `SHA-256`. `crypto.subtle.digest` is async and this is a cache key, not a
    security boundary. A 32-byte key is also 4× larger than needed.
  - Key must include **model version and label set**, or a model upgrade serves
    stale verdicts.
  - It is a new retention surface holding derived content. Bound it (a few
    hundred entries), scope it to the tab, and clear it on blur — and say so in
    the "what is collected" schema view.

### 11.3 Label restriction is right, but as written it breaks two documented capabilities

Restricting the label list is the cheapest real win here — GLiNER embeds labels
as prompt tokens, so cost scales with label count. But "only pass the exact
entity type the heuristic flagged" removes two of the four things the confirmer
is explicitly allowed to do:

| Capability | Survives label restriction? |
|---|---|
| Confirm a finding | yes |
| **Relabel** a finding | **no** — with only `["person"]` the model can say "not a person" but cannot say "organisation" |
| Recover a low-scored candidate | yes |
| **Discover** an unproposed entity | **no** — nothing to discover if only one label is in play |

`Hyundai reported record sales` and `Chase from procurement` are the two
documented relabel cases, and both are exactly what disappears. Worse, a lost
relabel does not degrade to "no answer" — it degrades to a *rejection*, which the
gate turns into "still uncertain", so the finding stays and the label stays wrong.

**Amendment: restrict to the candidate's label plus its confusion set.**

```ts
const CONFUSION_SETS: Record<EntityLabel, EntityLabel[]> = {
  person:       ['person', 'organization'],   // Hyundai, Chase — the documented failures
  organization: ['organization', 'person', 'location'],
  location:     ['location', 'organization'],
  address:      ['address', 'location'],
}
```

Two to three labels instead of ten keeps most of the speedup and loses only
far-fetched discovery. Discovery of a genuinely unproposed *type* becomes an
explicit, separate mode — run the full label set once per document on the web
app's file path, where the budget is 1 s and nobody is holding a keystroke.

Measure the accuracy cost of this on both held-out sets before shipping it. If
the confusion-set restriction moves either set's F1, the speedup is not free and
the trade needs stating rather than assuming.

### 11.4 The missing size win: prune the vocabulary, not the precision

`int4` is the wrong first move. ONNX Runtime Web's block-quantized `MatMulNBits`
coverage is thin, and int4 attacks the linear projections — which are not where
the 183 MB is.

**Where the weight actually sits.** GLiNER small v2.1 is a DeBERTa-v3-small
backbone with a 128k SentencePiece vocabulary. At 768 dimensions that embedding
matrix alone is ~98M parameters — the clear majority of an int8 checkpoint whose
whole backbone is ~140M. The transformer blocks are the minority of the download.

**So prune the embedding table.** Tokenize a large corpus of realistic prompts
(the synthetic corpus from item 7, plus the sample files and the corpora already
in-repo), keep the observed token rows plus all single-byte fallbacks, remap the
tokenizer, and drop the rest. A 128k → 32k working vocabulary removes roughly
three quarters of the embedding weight at **zero accuracy cost on in-vocabulary
text**, and out-of-vocabulary text degrades to byte-level fallback rather than
failing.

Projected: **183 MB → roughly 60–80 MB**, which changes the whole model-lifecycle
story in item 2 — a 60 MB fetch is a different conversation from a 183 MB one,
and it may make bundling viable instead of fetching.

This is worth attempting before any quantization or distillation work, because it
is a deterministic transform with a measurable, bounded accuracy risk. Distillation
is the fallback and it is a research task, not an engineering one — it needs
labelled data the project does not have, which is the same reason classification
is rule-based. Its real prerequisite is item 7's corpus.

### 11.5 The other missing win: batch the windows

Today, three ambiguous candidates in one document cost three inferences at ~8 ms
each. GLiNER exports with a dynamic batch axis, and the windows are already
padded to a fixed bucket by 11.2 — so batching them into a single call is close
to free and turns N sequential round trips into one.

This matters most on the web app's document path, where a 291 KB file can produce
many ambiguous findings, and it is where the Transferables work earns its keep.
Cap the batch (say 16) and chunk beyond that, so one pathological document cannot
occupy the session indefinitely.

### 11.6 WebGPU: worth doing, but not as a drop-in

The 5–10× figure is real for fp16 transformer workloads. Four things stand
between that number and this codebase:

1. **The int8 model and WebGPU are at odds.** ORT Web's WebGPU EP has limited
   int8 kernel coverage; quantized ops commonly fall back per-node to CPU or get
   dequantized to fp32, so an int8 checkpoint on WebGPU can be *slower* than
   int8 on threaded WASM. Getting the speedup means shipping **fp16** weights —
   which are larger, directly opposing 11.4 and item 2. The honest framing is a
   two-artifact trade, not a free win:

   | Artifact | Size | Warm inference | Cold start |
   |---|---|---|---|
   | int8, threaded WASM | smallest | baseline | slowest (WASM parse) |
   | int8, WebGPU | smallest | often no better; per-node fallbacks | shader compile |
   | fp16, WebGPU | ~2× int8 | fastest | shader compile |
   | int8 + pruned vocab, threaded WASM | **smallest by far** | baseline | fastest |

   Pick the row by measurement, and note that 11.4's row may beat WebGPU on
   *total* time-to-first-answer, which is the number a user actually feels.

2. **Two runtimes means two wasm binaries.** `onnxruntime-web/webgpu` uses the
   JSEP-enabled build, a different artifact from the `ort-wasm-simd-threaded.wasm`
   currently shipped at 9.5 MB. Shipping WebGPU *plus* a WASM fallback grows the
   extension well past its current 11 MB. Executable code cannot be fetched under
   MV3, so both must ship. Budget for it explicitly or pick one EP per build
   channel.

3. **Threaded WASM needs cross-origin isolation.** `numThreads > 1` requires
   `SharedArrayBuffer`, which requires the offscreen document to be
   cross-origin isolated — declared in the manifest:

   ```json
   { "cross_origin_embedder_policy": { "value": "require-corp" },
     "cross_origin_opener_policy":   { "value": "same-origin" } }
   ```

   This interacts directly with item 2: once COEP is `require-corp`, the weights
   fetch from the app origin needs `Cross-Origin-Resource-Policy: cross-origin`
   or proper CORS, or the fetch fails. Two features that look independent are
   not. Without isolation, `numThreads` silently stays at 1 and the
   "multi-threaded fallback" is single-threaded — test for it rather than
   assuming it.

4. **Feature-detect at runtime, in the offscreen document.** `navigator.gpu`
   presence is not availability; request an adapter, and treat a null adapter,
   a device loss, or a first-inference throw as a permanent downgrade to WASM
   for the session. Record which EP actually ran — see 11.8.

### 11.7 Speculative scanning conflicts with a promise the product has made four times

This is the one item I would not adopt as written.

`README.md` states, in the extension section and again in the tone section:

> No keystroke scanning, no mutation observers, no polling. Typing with the
> extension installed is byte-for-byte the same as typing without it.

A debounced `input` listener that reads the composer every 300 ms and runs a
model over partial drafts is keystroke scanning. The cost argument does not
rescue it — stage one is 0.05–0.6 ms, so this was never a performance promise. It
is a **trust** promise: the extension watches two discrete moments the user
initiates, and nothing else. Quietly converting it into a continuous reader is
the kind of change that, when a security reviewer notices it, costs more than the
latency ever did.

Two ways to get most of the benefit without breaking it:

**A. Speculation must be earned, like everything else here.** Once stage one has
flagged the buffer, a banner is already on screen and the user knows they are
being checked. Speculating *from that point on* is invisible and consistent — the
gate is the same one the whole engine uses. Concretely: speculate on the
already-intercepted `paste` event, then debounce-speculate only while a banner is
live. A prompt typed from scratch and never pasted still gets checked at submit,
which is the boundary that matters and the one the product says it defends.

This covers the case that actually hurts — long pasted documents with several
ambiguous findings — and leaves clean typing untouched.

**B. If continuous speculation is genuinely wanted, make it an explicit opt-in
setting, default off, and rewrite the README claim.** "Speculative pre-checking
(off by default): checks your draft as you pause so sends never wait." That is a
defensible feature. What is not defensible is keeping the sentence about
byte-for-byte typing while shipping code that contradicts it.

Recommendation: **A** for v1, **B** as a setting later.

### 11.8 Timeouts do not cancel, so build for the late answer

`Promise.race` stops *waiting*; it does not stop the inference. ORT Web has no
cancellation, so the worker keeps burning CPU or GPU on a result nobody will read,
and under repeated submits the queue grows behind the user.

Three things the race needs around it:

```ts
// Epoch guard: a late answer is discarded, never applied.
let epoch = 0
async function confirm(windows: Window[], budgetMs: number) {
  const mine = ++epoch
  const answer = await Promise.race([infer(windows), delay(budgetMs, null)])
  if (mine !== epoch) return null          // superseded
  return answer
}
```

- **Epoch counter** so a superseded answer is dropped. The existing design already
  does this at the UI layer ("if they clean, dismiss or send before it returns,
  the late answer is discarded") — extend the same discipline into the engine.
- **Concurrency cap of one in-flight batch** per offscreen session, with a queue
  depth of one; a third request replaces the second rather than joining a line.
- **Consecutive-timeout circuit breaker.** Three timeouts in a session means this
  machine cannot meet the budget; stop escalating for the session, fall back to
  deep-context, and record why. Better to be predictably deterministic than
  intermittently slow.

### 11.9 Deep-context as a pre-filter, not just a fallback

Worth proposing explicitly because the plan's gate table implies it: run the
deterministic `deep-context` confirmer *first*, and escalate to GLiNER only where
deep-context is also unsure. It is sub-millisecond and needs no files, so this
could remove a large share of inferences.

The caveat is measurable and must be measured: on the held-out sets, deep-context
scores 46/48 and over-flags once. As a pre-filter it would settle that case
itself, so its false positive is inherited rather than corrected — GLiNER never
sees the candidate it would have fixed. Net effect is unknown on 48 cases and
unknowable until item 7's corpus exists.

So: build it behind a flag, and let the calibration harness decide. It is exactly
the kind of question the grid search in item 7 should answer, with escalation rate
as a term in the utility function — which the proposed utility already has.

### 11.10 Measurement

`npm run check:perf` currently reports per-layer and end-to-end latency and
whether the confirmer was invoked. Extend it to report, as percentiles rather
than means:

- Time to first answer, split **cold** and **warm**, per execution provider.
- Inferences per document, and cache hit rate.
- Timeout-fallback rate and circuit-breaker trips.
- Escalation rate — the term the calibration utility penalises.
- Accuracy on both held-out sets **per configuration**, so no optimization ships
  without its accuracy cost beside it. Label restriction, vocabulary pruning and
  the deep-context pre-filter all trade accuracy for speed, and each needs its
  own row.

And this is where the console closes the loop: **Coverage & Health (§5.8) gains a
performance panel** fed by `engine.ms`, plus two new envelope fields:

```ts
engine: {
  // ...existing
  ep: 'webgpu' | 'wasm-threaded' | 'wasm' | 'none'
  coldStartMs?: number
  cacheHit: boolean
  timedOut: boolean
}
```

Lab benchmarks measure one developer laptop. The fleet measures the actual
hardware distribution — which is the only place a question like "does WebGPU
help our users" can honestly be answered, and it is why the perf work and the
console belong in the same plan.

### 11.11 Sequencing

Cheapest and safest first; the two that change the artifact last.

| Order | Change | Risk | Expected effect |
|---|---|---|---|
| 1 | Sequence buckets + pre-warm on idle | none | removes realloc + first-use spike |
| 2 | LRU window cache (sync hash, versioned key) | low | near-zero cost on repeated clauses |
| 3 | Epoch guard, concurrency cap, circuit breaker | low | removes the runaway-queue failure |
| 4 | Batch windows into one inference | low | N round trips to 1 on documents |
| 5 | Confusion-set label restriction | **medium — accuracy** | large compute cut; measure both sets |
| 6 | Earned speculation (11.7 option A) | low | submit usually hits a warm cache |
| 7 | Vocabulary pruning | **medium — accuracy** | 183 MB to ~60–80 MB |
| 8 | Deep-context pre-filter, behind a flag | **medium — accuracy** | large inference cut; needs item 7 |
| 9 | WebGPU EP with runtime detection | medium — size, compat | 5–10× warm, only with fp16 |
| 10 | int4 / distillation | high | speculative; last resort |

Steps 1–4 are pure engineering with no accuracy exposure and should land first.
Steps 5, 7 and 8 each need an accuracy row in `check:perf` before they ship.
Step 9 needs the size budget resolved and should be measured against step 7
rather than assumed to beat it.

---

## 12. Measured — what the performance workstream actually found

Section 11 was written from reasoning. This section is what the numbers said
when the work was done, including where the reasoning was wrong. All figures:
GLiNER small v2.1 int8, `onnxruntime-node`, warm unless stated, Apple silicon.
Absolute times wobble ~30% between runs; the ratios and the accuracy counts are
stable, so those are what is quoted.

### 12.1 Label restriction: the win was already banked

Label count isolated — one loaded session, four windows per call, interleaved
across configurations, fifteen rounds:

| labels | median | per window |
|---|---|---|
| 1 | 26.1 ms | 6.5 ms |
| 2 | 26.9 ms | 6.7 ms |
| 3 | 29.1 ms | 7.3 ms |
| 10 | 43.0 ms | 10.7 ms |

Label count does matter: 10 → 3 is a 32% saving. But `DEFAULT_LABELS` in
`gliner.ts` was already `{person, organization, location}`, so §11.3's premise —
"never pass a generic 20-label list" — described a problem this codebase did not
have. The remaining 3 → 2 is **7.6%**, and 1 label breaks the relabel outright:
`Hyundai reported record sales` returns `reject` instead of
`confirm:ORGANISATION`.

Worse, per-candidate label sets force batch fragmentation, and fragmentation
costs more than the labels save. Adjudicating eight windows:

| shape | median |
|---|---|
| 1 call × 8 windows, 3 labels | 68.8 ms |
| 1 call × 8 windows, 2 labels | 65.5 ms |
| **2 calls × 4 windows, 2 labels** | **70.2 ms** |
| 4 calls × 2 windows, 2 labels | 78.3 ms |
| 8 calls × 1 window, 2 labels | 101.4 ms |

Splitting into merely two calls already loses more than two labels gain.
**Not implemented.** The confusion-set mechanism would be worth building for a
checkpoint with a large label vocabulary, where 10 → 3 is on the table; for this
one it trades a documented capability for single-digit percent.

### 12.2 The real lever is window count, not label count

`batchSize` and `labelCount` were the wrong things to watch. The dominant term
is how many windows get submitted, and windows overlapped almost completely:

| document | candidates | distinct windows | chars fed to model | chars in region |
|---|---|---|---|---|
| dense ambiguous | 11 | 11 | 2 978 | 502 |
| dense × 4 | 44 | 44 | 14 072 | 2 014 |

Eleven candidates in eight lines had the model read the same 502-character
region eleven times, returning 73 spans for what were really ten entities. The
consistency pass downstream was then reconciling duplicates that never needed
creating.

### 12.3 Merging works, but the cap *is* the setting

The first attempt merged with a 1 200-character cap, chosen for position-embedding
headroom. It was 4.8× faster and **lost three findings in thirteen**:

| lost at cap 1200 | why it matters |
|---|---|
| `Chase` | `Chase from procurement` — a documented relabel case |
| `Hyundai` | `Hyundai reported record sales` — the other documented case |
| `Hope` | an ordinary recovered name |

Two findings also dropped from `high` to `medium`, which under policy is the
difference between "Certain" and "Possible", and medium never blocks.

Sweeping the cap found a cliff:

| cap | windows | median | findings | certain | lost |
|---|---|---|---|---|---|
| off | 11 | 443 ms | 13 | 6 | — |
| 250 | 9 | 451 ms | 13 | 6 | none |
| **350** | **5** | **190 ms** | **13** | 5–6 | **none** |
| 500 | 2 | 113 ms | 11 | 6 | Chase, Hope |
| 800 | 1 | 68 ms | 10 | 4 | + Hyundai |
| 1200 | 1 | 68 ms | 10 | 4 | + Hyundai |

Past ~500 characters GLiNER turns conservative on the longer sequence and stops
seeing entities it found in a narrower one. A 4.8× speed-up that drops three
findings in thirteen is not a speed-up, it is a leak.

**350 is the setting because it is barely more than the ~320 characters a single
candidate already gets.** Merging at that cap does not show the model more text;
it stops cutting one region into eleven overlapping copies. That is why recall
holds exactly while the work halves — and it is why the property the README
states ("a small window, never the document") survives the change.

### 12.4 Verification before it became the default

| check | one window per candidate | merged, cap 350 |
|---|---|---|
| Held-out set 1, F1 | 95.2% | **95.2%** |
| Held-out set 2, F1 | 100% | **100%** |
| dense: findings | 13 | **13** (0 lost, 0 gained) |
| dense: windows / time | 11 / 443 ms | **5 / 190 ms (2.3×)** |
| dense × 4: findings | 49 | **49** (1 lost, 1 gained — same value, different occurrence) |
| dense × 4: windows / time | 19 / 500 ms | 13 / 456 ms (1.1×) |
| corpus | 0 FP / 0 FN | **0 FP / 0 FN** |

Confidences shift by roughly ±0.05, mostly upward. Now the default:
`{ merge: true, maxChars: 350 }`, with `setWindowStrategy()` to override and a
test pinning the cap so raising it is a deliberate act with a failing test
attached.

### 12.5 A gap this exposed

**Neither existing benchmark can score a windowing change.** `check:corpus` calls
the synchronous `scan()`, so it never escalates; both held-out sets are one
sentence per case, so merging does not activate on them. They reported "no
change" for a setting that loses three findings on a dense document.

The A/B above only exists because `--group N` was added to `check:heldout`,
packing cases into value-disjoint documents. Value-disjoint matters: these sets
are built around the same word appearing once as a person and once as not
("Chase" the colleague, "Chase" the bank), so a naive grouping would pit the
expected labels against the engine's own entity-consistency pass and measure the
grouping instead of the windowing.

This is item 7's corpus problem arriving early. **Any future change to windowing,
batching, or model weights needs a multi-candidate labelled document set**, and
the synthetic corpus is the prerequisite for pruning as much as for threshold
calibration.

### 12.6 Two incidental findings

- `@xenova/transformers` bundles `onnxruntime-node@1.14.0` alongside the
  project's `1.19.2`, and both load, printing a duplicate-class warning about
  "spurious casting failures and mysterious crashes". Benign in Node today, but
  it is two ORT versions in one process and should be pinned before the pruned
  model lands.
- Cold start is ~1.9 s in Node. §11.1's guess of ~1.0 s was optimistic, which
  makes the held-send cold-decline rule more clearly right, not less.

---

## 13. Phase 2.1 — vocabulary pruning, done

Result: **183.4 MB → 109.7 MB (−40%)**, cold start **1065 ms → 565 ms**, and no
accuracy change on anything measurable. Shipped as `npm run provision:prune`,
with `npm run bench:accuracy` as the gate.

### 13.1 The payload was one tensor

| tensor | dtype | dims | size |
|---|---|---|---|
| `word_embeddings.weight_quantized` | UINT8 | [128004, 768] | **98.3 MB** |
| every other initializer | INT8 / FLOAT | ≤ [3072, 768] | ≤ 2.4 MB each |
| total (231 initializers) | | | 182.4 MB |

The embedding table is **54%** of the checkpoint. That also fixes the floor:
non-embedding weight is 84.1 MB, so vocabulary pruning alone cannot reach the
plan's 65–75 MB target no matter how aggressive it is. 32k lands at 109.7 MB
and 16k at 97.4 MB. Getting below 84 MB needs a different lever.

### 13.2 The byte-fallback premise was wrong, and it did not matter

§2.1 of the plan says to "retain the top 30,000 plus all single-byte fallback
tokens (0–255)" so OOV degrades to bytes. Two problems:

- the tokenizer is SentencePiece **Unigram** with `byte_fallback: false`, and
  transformers.js implements `byte_fallback` **only in its BPE class** — setting
  the flag would have been silently ignored;
- it is unnecessary. Every single character is in the low-id region, so
  Unigram's Viterbi routes around a missing piece using finer surviving pieces.
  Measured **zero `[UNK]`** at 64k, 32k and 16k.

```
Thandeka Mokoena   128k -> ['▁Than','d','eka','▁Moko','ena']
                    16k -> ['▁Than','de','ka','▁Mo','ko','ena']
```

The real cost is token inflation, and it is **not evenly distributed**:

| text | 64k | 32k | 16k |
|---|---|---|---|
| non-Western names | 1.18× | 1.23× | 1.55× |
| Anglo names | 1.00× | 1.00× | 1.00× |
| business prose | 1.15× | 1.15× | 1.15× |

Pruning taxes exactly the names the model exists to catch. It does not break
them — recall stayed 8/8 — but the sequences get longer, so the tax is real and
grows as the vocabulary shrinks. Worth stating rather than discovering later.

A first pass predicted this would be fatal, on the grounds that 11 of 13
diverse names contain a subword outside the top 32k (`Thandeka Mokoena` reaches
id 106803; `Chukwuemeka Okonjo` 102689) while `John Smith` tops out at 2430.
That reasoning was wrong: high piece ids mean *re-segmentation*, not `[UNK]`.
Incidentally the same check found `▁summarise` at id 68625 — a word this
product's own prompt improver emits sits outside the top 32k.

### 13.3 The trap: GLiNER bakes a token id into the graph

The first pruned artifact loaded, ran, and returned almost nothing:

| | full | pruned 32k, first attempt |
|---|---|---|
| held-out set 1 F1 | 95.2% | **30.8%** |
| held-out set 2 F1 | 100% | **0%** |
| dense findings | 13 | **3** |
| rare-name recall | 8/8 | **2/8** |

Everything checked out individually — every retained embedding row was
byte-identical, the four specials mapped correctly, node count matched, both
`tokenizers` and transformers.js emitted ids inside the new range, and a no-op
serialization round-trip scored 95.2%/100%. The cause was in the graph:

```
Constant(128002) -> Equal(input_ids, ·) -> NonZero
```

`128002` is `<<ENT>>`. GLiNER locates the markers separating the label prompt
from the text by comparing `input_ids` against that **hardcoded literal**. Moving
`<<ENT>>` to 32002 left the model comparing against an id that no longer
existed, so it found no entity markers and emitted no spans. It failed silently
and plausibly — the worst failure mode available.

`prune-vocab.py` now remaps any scalar graph constant matching a relocated
special id, prints what it patched, and refuses to write a model that still
references an id past the end of the table.

Worth noting for Phase 2 generally: **the pruning simulation was right all
along.** Restricting the vocabulary at tokenization time (full table, specials
left in place) predicted no accuracy loss, and the finished artifact agrees
once the constant is patched. Simulating a vocabulary restriction before doing
graph surgery costs minutes and would have isolated this immediately.

### 13.4 Verified

Three runs each, one model per process:

| | full 128k | pruned 32k | pruned 16k |
|---|---|---|---|
| payload | 183.4 MB | **109.7 MB** | 97.4 MB |
| cold start | 1065 ms | **565 ms** | ~750 ms |
| held-out set 1 F1 | 95.2% | **95.2%** | 95.2% |
| held-out set 2 F1 | 100% | **100%** | 100% |
| dense findings | 13 | **13** | **12** |
| dense windows / time | 5 / 145 ms | 5 / 141 ms | 5 / ~180 ms |
| rare-name recall | 8/8 | **8/8** | 8/8 |

**32k is the setting.** Accuracy-identical to the full checkpoint on every
measure, 40% smaller, and roughly half the cold start. 16k reliably loses one
finding on the dense document across every run, which is the token-inflation
tax showing up as a real regression — the extra 47% saving is not worth it.

`npm run provision:prune` produces it. Not yet the default in
`gliner.ts` DEFAULTS: the pruned artifact is derived from the provisioned one
and needs Python with `onnx` and `numpy`, so making it the default would break
anyone who has run `provision:model` alone. Switching it over means either
chaining pruning into provisioning or having `isAvailable()` prefer the pruned
directory when present — a small change, but it changes the provisioning
contract, so it is called out rather than slipped in.

### 13.5 `npm run bench:accuracy`

The gate §2.1 asked for. Scores one checkpoint on four things at once, because
weights and windowing can move any one without touching the others: held-out F1
on both sets, findings on a dense multi-candidate document, and **rare-name
recall**. That last column is the important one — it is the documented reason a
model is here, it is what vocabulary pruning taxes first, and a change that
holds F1 while breaking it has broken the feature and passed the benchmark.

One model per invocation, deliberately: loading is process-global in
`transformers`, and comparing checkpoints in one process invites a number that
describes whichever loaded first.

### 13.6 Phase 2.2 is still not worth doing

Nothing here changes §12.1's conclusion. Confusion-pair label restriction saves
7.6% (3 labels → 2) on a checkpoint that already passes 3, costs the LOCATION
relabel, and any per-candidate label set fragments the batch — and fragmentation
costs more than the labels save. Token bucketing is not reachable from this
layer either: padding happens inside `gliner`/ORT, not in code this project
owns.

The window merging in §12 already collected the batching win, and it collected
far more of it: 2.3× against 7.6%.

---

## 14. Phase 2 closed — what shipped, and what was declined

### 14.1 The pruned checkpoint is now the default when present

Resolution moved into `createGlinerConfirmer`. `VARIANTS` is an ordered
preference list; the first checkpoint that actually exists wins:

```
gliner-small-32k   109.7 MB   preferred
gliner-small       183.4 MB   fallback
```

Verified in all three states — both present (picks 110 MB), pruned absent
(falls back to 195 MB), full absent (uses 110 MB). Passing `modelName` or
`modelFile` pins one checkpoint and disables resolution, which is what the
benchmark scripts need: they score a named artifact, not "whatever is
installed".

`npm run provision:model` now attempts the prune at the end, **best effort**.
It needs Python with `onnx` and `numpy`, and provisioning has to keep working
on a machine with neither — so a failure there prints what to install and
carries on. The fallback means that costs download size, not function.

One detail worth keeping: `cost.bytes` returns the fallback's size *before*
resolution rather than 0. The escalation gate reads `bytes === 0` as "free to
run, never gate it", so a confirmer with weights must not look free merely
because nobody has asked yet.

### 14.2 Step 2.1's script was not used, and should not be

The shipped `prune-vocab.py` operates on the **already-validated int8 graph**:
slice rows, patch the constants, save. The proposed script instead reloads the
PyTorch model, re-exports to ONNX, and re-quantizes. That is a bigger, riskier
operation for the same result, and it has five concrete faults:

1. **It never patches `Constant(128002)`.** This is the failure documented in
   §13.3 — silent, plausible, and worth 95.2%/100% → 30.8%/0%.
2. **`gliner_custom_tokens = {"[ENT]", "[SEP]"}`** — the real tokens are
   `<<ENT>>` and `<<SEP>>`. `convert_tokens_to_ids("[ENT]")` returns the unk id,
   so the guard silently protects nothing.
3. **`sorted(set(preserved_indices))[:TARGET_VOCAB_SIZE]`** appends the
   out-of-range specials and then truncates back to 32 000, dropping them again.
   The code states an intent it does not carry out.
4. **The `torch.onnx.export` signature does not match GLiNER.** Three inputs
   and a single `logits` output is not the span-level graph `gliner` drives; the
   export would produce a model the runtime cannot use.
5. **`per_channel=True, reduce_range=True`** re-quantizes with different
   numerics from the shipped checkpoint, so every accuracy figure would need
   re-establishing rather than comparing.

It also needs `gliner` + `torch` in Python, against `onnx` + `numpy` for the
graph surgery.

### 14.3 Steps 2.2 and 2.3 were declined on measurement

The measured case against them is in §12.1: 3 labels → 2 saves 7.6%, costs the
LOCATION relabel, and per-candidate label sets fragment the batch — where
fragmentation costs more than the labels save (70.2 ms for two calls against
68.8 ms for one call with all three labels). Window merging already took the
same win at 2.3×.

The draft `batcher.ts` and `worker.ts` would also not work as written:

- `cand.type` — `Finding` has no `type`; it is `category`, and the values are
  `PERSON` / `ORGANISATION`, not lowercase `person`. Every lookup would miss
  `CONFUSION_SETS` and fall through to a single invented label.
- `wordsMask[offset + j] = 1` for every token contradicts its own comment.
  The mask marks subword *starts*; setting all of them destroys span
  alignment, which is what the span-level head indexes on.
- Hand-building `input_ids` / `attention_mask` / `words_mask` bypasses
  `gliner`'s preprocessing, which assembles the `<<ENT>> label <<SEP>> text`
  prompt and the span indices. Bypassing it means re-implementing span
  decoding from raw logits — replacing a working, measured pipeline with a
  hand-rolled one to chase 7.6%.
- It re-derives windows at ±160 characters, duplicating `windowFor` and
  discarding the merging that is worth 2.3×.

Sequence bucketing is not reachable from this layer at all: padding happens
inside `gliner`/ORT, not in code this project owns.

### 14.4 Phase 3 note: Node numbers cannot settle the bake-off

Current state, `npm run bench:accuracy`:

| | full 128k | pruned 32k |
|---|---|---|
| payload | 183.4 MB | **109.7 MB** |
| cold start | 1576 ms | **779 ms** |
| dense: 5 windows | 174 ms | 171 ms |

Per window that is ~34 ms, which sits inside the plan's own "if threaded WASM
completes in 25–40 ms, do not bundle the JSEP binary" threshold — so on its face
the criterion says skip WebGPU.

**It does not, yet.** These are `onnxruntime-node`, which is native. Browser
WASM is materially slower, and the whole question is what happens in a browser.
Phase 3 needs the measurement taken *in* the extension, through `LocalSource`,
before the bundling decision is made. The metrics envelope already carries `ep`,
`coldStartMs` and `windowCount` for exactly this, and it is the one question
where the fleet answers something a laptop cannot.

---

## 15. Phase 4.1 — Unicode normalisation, done

`src/engine/normalise.ts`, wired into `scan()` ahead of every detector. 300
tests, corpus still 0 FP / 0 FN, and the 291 KB benchmark unchanged at 223 ms.

### 15.1 NFKC does most of the job

Measured before the fold table was written, because it decides how big the
table needs to be:

| | NFKC handles it |
|---|---|
| full-width digits and letters (`０`, `ａ`) | **yes** |
| mathematical alphanumerics (`𝐀`, `𝗔`) | **yes** |
| non-breaking and narrow spaces | **yes** |
| ligatures (`ﬁ` → `fi`) | **yes** |
| combining-mark composition (`e`+`U+0301` → `é`) | **yes** |
| zero-width space / joiner / BOM / word joiner | no |
| soft hyphen | no |
| dashes (en, em, minus) | no |
| curly quotes and apostrophes | no |
| Cyrillic and Greek confusables | no |

§3 of the remediation plan's `SKELETON_MAP` listed `０`–`９` and
` ` explicitly — all six rows above that NFKC already covers. The shipped
table contains only the bottom five rows.

### 15.2 Three corrections to the drafted implementation

All three were predicted in §11's review and all three held up:

1. **Per-character `normalize('NFKC')` is not NFKC.** It composes across
   combining sequences, so `e` + `U+0301` is two characters that become one and
   a character-at-a-time loop cannot express it. Iteration is by grapheme
   cluster via `Intl.Segmenter`, with a code-point fallback.
2. **`Int32Array(len * 2)` can overflow.** Expansion is real — `ﬁ` is one
   character that becomes two — and is not bounded by any small constant, so
   the maps grow rather than being sized by a guessed multiple.
3. **`projectRange` mis-maps the end offset.** One raw character can produce
   several normalised ones, so a single index per position cannot answer both
   questions. Each normalised character records `[rawStart, rawEnd)` of the
   cluster it came from, and projection reads the start of the first and the
   end of the last.

The draft also had `hasAnomalies` as a local. It is now `ScanResult.normalised`,
because "this text contained hidden characters" is worth knowing on its own —
text is not usually obfuscated by accident.

### 15.3 The invariant, and why it is the real risk

Detection runs on normalised text; the sanitizer rewrites the user's actual
document, the highlighter draws on it, and the Word writer maps offsets into
runs. So findings are projected back, and their values re-sliced from the
original rather than kept from the normalised copy — reporting the normalised
spelling would hand the sanitizer a string that does not occur in the document,
and the finding would be shown and then quietly fail to be removed.

Two tests pin it across seven obfuscated documents:

```
raw.slice(finding.start, finding.end) === finding.value      // for every finding
scan(sanitize(raw, findings).text).findings === []           // nothing survives cleaning
```

### 15.4 What it now catches

Each of these was missed before and is detected and cleaned now:

| input | found |
|---|---|
| `sarah.mitchell@exa<ZWSP>mple.com` | EMAIL |
| `sarah.mit<SHY>chell@example.com` | EMAIL |
| `+27<NBSP>82<NBSP>555<NBSP>0198` | PHONE |
| `＋２７８２５５５０１９８` | PHONE |
| `4111–1111–1111–1111` (en dashes) | CREDIT_CARD |
| `password=‘Hunter2Hunter2’` (curly quotes) | PASSWORD |
| `jirа.acme.internal` (Cyrillic а) | INTERNAL_HOST |
| `AKIАIOSFODNN7EXAMPLE` (Cyrillic А) | API_KEY |

One case from the original review does **not** work, and it is not a
normalisation failure: `https://pаypal.com/login` still finds nothing, because
the URL rule does not flag public domains — plain `paypal.com` finds nothing
either. Worth recording so it is not mistaken for a regression later.

### 15.5 Cost

Zero on ASCII, which is nearly every document: a `charCodeAt` scan takes the
fast path and returns the same string reference. The 291 KB benchmark is
unchanged at 223 ms. The non-ASCII path has its own scaling assertion, on the
same reasoning as `performance.test.ts` — a stopwatch measures the machine as
much as the code.

---

## 16. Phase 4.2 — attachment interception, partial by design

`extension/src/files.ts`, wired into `install()`. 313 tests, corpus unchanged,
content script 17.7 KB → **22.1 KB**.

### 16.1 The measurement that decided the architecture

The plan routes extracted buffers straight to `src/files/extract.ts` from the
content script. Measured cost of doing that:

| content bundle | size |
|---|---|
| before | 17,679 bytes |
| with `extractFile` reachable | **3,213,652 bytes** |

`extract.ts` lazily imports `xlsx`, `jszip` and `pdfjs-dist`, but a content
script is injected as a classic script, so dynamic imports inline instead of
splitting. 3.2 MB parsed on every ChatGPT, Claude, Gemini and Copilot page
load, whether or not anybody ever attaches a file — the exact cost this project
refuses to put on the normal path.

So this increment reads what costs nothing (`.txt` `.md` `.log` `.json` `.csv`
`.tsv`, via `file.text()`) for **4.5 KB**, and Office and PDF formats are
announced as unchecked rather than passed silently — the same rule the send
path already follows: "we found nothing" and "we could not look" are different
states. Binary extraction belongs in the offscreen document, which already
carries weight and can code-split, and that is the follow-up.

Stated plainly because a half-built protection that looks whole is worse than
none: **a `.docx` dropped on ChatGPT today gets a warning, not a clean.**

### 16.2 The recursion bug, reproduced and pinned

§1 of the plan tags the replayed event with `__ai_safe_bypass` and never checks
the flag in the capture handler. Removing the guard from the shipped version
reproduces what that does:

```
Error: Worker exited unexpectedly
```

Not a failed assertion — the test process dies. In a browser that is the tab.

The shipped guard is a `WeakSet` of the event objects we dispatched, rather than
a property on the node: the node is reachable from the page, and an expando is
both readable and forgeable there.

### 16.3 Two further corrections

**`preventDefault()` on `change` does nothing** — the event is not cancelable,
so `stopImmediatePropagation()` is the entire mechanism. Commented in place,
because it reads as belt-and-braces and is load-bearing in one direction only.

**`instanceof EventTarget` silently drops the replay.** The drafted version
guards the re-dispatch with an `instanceof` check; `instanceof` is false across
realms, and an event crossing a frame boundary carries objects from another
one. So the check would discard the replay for precisely the drops that came
from an embedded composer. Duck-typed on `dispatchEvent` instead — and this was
found by a test failing, not by reading.

### 16.4 What the tests cover

Thirteen cases. The decision logic is tested against injected dependencies
rather than a worker and a shadow root, which is also why `files.ts` takes its
dependencies as an argument: the content script stays the only thing that talks
to the worker, and the module under test needs neither.

- a clean text file passes without asking anybody;
- a cleaned copy is substituted **under the same name** — the user picked the
  file and should recognise what lands in the conversation;
- block offers no override; warn does;
- `.docx` / `.xlsx` / `.pdf` warn exactly once and are never sent to the
  worker;
- `.png` stays silent, because warning about every image is noise and noise is
  how a safety tool gets switched off;
- a worker that does not answer warns rather than implying clean;
- a drop is held and replayed **exactly once**;
- a cancelled drop is never delivered;
- a file picker is held, the file swapped, and the site's listener sees only
  the replacement;
- nothing survives → `input.value` cleared, so the page cannot later find a
  file the user withheld;
- a `change` on a text input is ignored entirely.

### 16.5 Known limitations

- Office and PDF attachments warn but are not cleaned (§16.1).
- A site tracking `dragenter` / `dragleave` counters may be left one deep after
  a held drop; the replay dispatches `drop` only. Visible as a dropzone
  staying highlighted, and it clears on the next interaction.
- The replayed events have `isTrusted: false`. Every composer tested reads
  `dataTransfer` and does not check the flag, but a site that did would reject
  the replay — and would then show the user nothing was attached, rather than
  attaching something unchecked.
- happy-dom's `DragEvent` constructor drops `dataTransfer` from its init
  dictionary, so the tests define it on the instance. Chrome honours the
  constructor; the payload path is therefore asserted only indirectly, via the
  replay count and the file-picker case.

---

## 17. Phase 4.2 completed — documents are read where the parsers belong

`.docx`, `.xlsx` and `.pdf` attachments are now extracted, scanned, judged and
rewritten. 326 tests, corpus unchanged.

### 17.1 The bundle, which was the whole design constraint

| | size | loaded |
|---|---|---|
| `content.js` | **23.2 KB** | every AI page load |
| `offscreen.js` | 116.6 KB | on demand, outlives the worker |
| `xlsx` chunk | 691.8 KB | only when a spreadsheet is opened |
| `pdf` + worker chunks | 2.2 MB | only when a PDF is opened |
| `jszip` chunk | 149.3 KB | only when a Word file is opened |

Against the 3.2 MB the content script would have carried. The whole feature
costs the page-load path **5.5 KB** over where it started, because the parsers
live in the one context that is created on demand and can code-split.

### 17.2 Where the judgement runs

The whole job — extract, scan, evaluate policy, and rewrite when asked — happens
in the offscreen document (`extension/src/attachment.ts`). The worker relays;
the content script reads the page, asks, and renders. That keeps the rule the
enforcement point has always followed, and it means a `.docx` is judged by the
same detectors, the same confidence model and the same policy as a pasted
prompt, so the two cannot disagree about identical content.

Bytes cross as base64 because **MV3 messages are serialised through JSON, not
structured clone** — an `ArrayBuffer` arrives as `{}`. `toBase64` chunks at
0x8000 rather than spreading the array into `String.fromCharCode`, which
overflows the call stack: the naive version throws `RangeError` at attach time
on exactly the large files most worth checking.

The bytes move twice only if the user asks for a clean copy — judge first,
rewrite on request. The alternative was decoded state somewhere with an
eviction policy, for a file the user is looking at right now.

### 17.3 What the tests prove

Eight cases in `attachment.test.ts`, using the repo's existing Office fixtures,
plus ten more on the content-script path with the reader injected.

The one that matters is the round trip: a Word document goes in as base64,
comes back judged, is asked to be rewritten, and the rewritten bytes are
**re-opened and re-scanned** to confirm the values are gone — from the body,
the table, the header and the footer. Three things have to have worked
(extraction, the rewrite, the transport) and only re-opening proves all three.
The spreadsheet case additionally asserts the second sheet survives, so the
rewrite is not quietly flattening structure.

Also pinned: base64 round-trips a 2 MB buffer that the naive implementation
cannot; a corrupt `.docx` warns rather than reporting clean; an image is
ignored silently; a file over the cap is never sent; and a failed rewrite
withholds the file rather than attaching the original.

### 17.4 Limits, stated

- **Over 10 MB is announced as unchecked.** The encoded string, the decoded
  copy and the parsed document all coexist, so the cap is really a cap on
  memory.
- **Firefox has no offscreen API**, so documents there are reported as unread.
  Consistent with how the model already degrades on that browser, and it warns
  rather than passing silently.
- **A PDF comes back as `.txt`.** Rewriting PDF layout reliably is out of
  scope; the writer renames the file rather than handing back something that
  claims to still be a PDF.
- The `dragenter`/`dragleave` and `isTrusted` caveats from §16.5 are unchanged.

---

## 18. Item 7 — the document corpus, and the decision it reversed

`bench/frames.ts` + `npm run corpus:generate` + `npm run check:documents`.
745 documents, 1,945 labelled spans (1,357 to find, 588 traps), 12 evidence
families, three density bands. Deterministic from one seed, git-ignored,
folded into `npm run check`.

### 18.1 Why the old benchmarks could not see this

Both blind spots were real and both had already produced a wrong number:

- `check:corpus` calls the synchronous `scan()`, so it never escalates and
  cannot observe the confirmer at all;
- both held-out ambiguity sets are one sentence per case, so window merging
  never activates on them.

They duly reported "no change" for a merge cap that turns out to cost 3.2
points of recall. An instrument that cannot see the thing you are changing is
worse than no instrument, because it produces a number.

So this corpus is **documents** at three densities — 1, 4 and 9 candidates —
with rounds tuned per band so the three contribute comparable span counts.
Left to itself, one-slot documents outnumber nine-slot ones ten to one, and the
dense ones are the entire reason it exists.

### 18.2 The reversal

Merging was made the default two sections ago on the strength of **one**
hand-written document: 13 findings before, 13 after, 2.3× faster. Scored with
GLiNER against 564 labelled positives across 90 dense documents:

| cap | windows | recall | label accuracy |
|---|---|---|---|
| off | 340 | **73.9%** | 95.9% |
| 250 | 319 | 72.7% | 96.8% |
| 350 | 258 | 70.7% | 96.7% |
| 800 | 258 | 62.6% | 98.3% |

Monotonic, and not free at any cap. There is also a counter-trend worth
naming: **longer sequences make the model more conservative about finding an
entity and better informed about labelling one.** Coherent, and the wrong way
round for this product — a missed finding is a leak, a mislabelled one is still
redacted.

The speed was also being spent in the wrong place. Stage two runs behind a
banner that is already on screen with a two-second budget, and unmerged dense
documents come in at 433 ms. Nothing was waiting for the 2.3×.

**Merging is now off by default**, with the mechanism kept, tested and
switchable, and the numbers in the doc comment so turning it on is a decision
rather than an accident. A checkpoint less sensitive to sequence length would
make it free; `npm run check:documents -- --gliner --density dense` is how to
find out.

`bench:accuracy` was also forcing `merge: true`, so the accuracy gate had been
scoring a configuration the product no longer used. It now measures the
default and prints which windowing it saw.

### 18.3 What the corpus says about the engine

Deterministic confirmer, all 745 documents:

| slice | positives | recall | precision | traps sprung |
|---|---|---|---|---|
| overall | 1,357 | 68.4% | 100.0% | **0.0%** |
| sparse | 345 | 67.5% | 100.0% | 0.0% |
| medium | 448 | 69.9% | 100.0% | 0.0% |
| dense | 564 | 67.7% | 100.0% | 0.0% |

Per family, which is the useful view:

| family | recall |
|---|---|
| title (`Dr X reviewed…`) | **100.0%** |
| person-verb (`X joined…`) | 98.3% |
| role-after (`X from procurement`) | 77.3% |
| email-corroborated | 57.9% |
| possessive (`X's report`) | 49.6% |
| cue-word (`contact X`) | 43.2% |
| unsupported (`copy X on the reply`) | **17.8%** |

Two things stand out. **Precision is 100% and not one of 588 traps was sprung**
— the false-positive work holds up far outside the corpus it was tuned on.
And recall is much lower than the held-out sets implied (90.9–100%), because
those sets are dominated by strong-evidence sentences. `unsupported` at 17.8%
is the README's own documented limitation, now with a number on it.

Recall is the honest headline: **the engine finds roughly two thirds of the
people in a document, and never invents one.** That is a defensible posture for
a tool whose warnings must be trusted, and it is a much more useful thing to
know than "95.2% F1".

### 18.4 The family split, and what it is for

`HELD_OUT_FAMILIES` reserves `possessive`, `function-word-after` and
`unsupported` for validation. Today's numbers are all equally unseen — the
engine predates the corpus — so the split matters for *future* tuning: anyone
calibrating a threshold here has a slice they did not fit to.

The current gap (75.7% on tuning families against 33.6% held out) overstates
generalisation loss, because `unsupported` is the known-hardest family and it
landed in the held-out third. Worth knowing before quoting that number.

### 18.5 What it is not

Not real data. Frames are written by hand, so the corpus can only contain text
shapes somebody thought of, and it is not evidence that the engine handles
prose nobody imagined. It is an instrument for detecting regression and for
comparing two configurations — which is precisely what was missing, and it
caught a wrong decision within an hour of existing.

One mechanical note for whoever uses it: `npm run check:documents -- --cap 800`
works typed literally but the flag is **lost when passed through a shell
variable**, which silently scores the default instead. Two of the first
comparison runs were invalid for that reason.

---

## 19. Item 10 — entropy validation for secrets

`src/engine/entropy.ts`, gating the two rule families that feed a category the
policy layer is allowed to **block**. 359 tests, corpus unchanged at 0 FP / 0
FN.

### 19.1 The drafted floors are unreachable, and the reason is arithmetic

§10 of the plan sets `entropy >= 4.5` as the fallback for a generic secret
assignment, behind a `length >= 16` gate. A string of length n holds at most n
distinct symbols, so its per-symbol Shannon entropy cannot exceed **log2(n)**:

| length | maximum possible entropy |
|---|---|
| 16 | 4.00 bits |
| 20 | 4.32 bits |
| 23 | 4.52 bits |

So the 4.5 floor rejects every candidate shorter than 23 characters —
*including everything that passes its own length gate*. The rule reads as
strict and is inert. `validateStripeKey`'s `>= 4.0` on a 24-character payload
caps at 4.58 and would reject valid keys for the same reason.

The measure here is normalised instead: entropy over the maximum a string of
that length, drawn from that alphabet, could have. 0..1, and it means the same
thing at every length — which is what a threshold needs. The alphabet is
inferred from the content, so `deadbeef` is scored against hex rather than
against the eight characters it happens to use.

### 19.2 Entropy alone does not separate secrets from words

Measured, on real-shaped values:

| value | ratio | is it a secret? |
|---|---|---|
| `xK3mP9qR7wL2nZ8vB5cY` | 1.000 | yes |
| `9f8e7d6c5b4a3210fedcba9876543210` | 1.000 | yes |
| `password123` | 0.947 | **no** |
| `changeme` | 0.917 | **no** |
| `ProductionDatabase` | 0.883 | **no** |
| `aG9tZS9pYW4vLmNvbmZpZw==` | 0.866 | yes |
| `CustomerContactList` | 0.827 | **no** |

`ProductionDatabase` at 0.883 outscores a real base64 secret at 0.866. English
is not predictable enough at the character level for entropy to separate these,
so a second test does the work: a value that reads as **language** is rejected
regardless of its ratio. Both checks are load-bearing — neither is a backstop.

A bug worth recording, because it was subtle and the first version shipped it
into a measurement: judging vowel structure *after* stripping digits. `9f8e7d6c…`
reduces to `fedcba…`, which has vowels in all the right places and no consonant
runs, so a perfectly random hex key read as English and was rejected. The
interleaved digits are exactly the signal that it is not language, and throwing
them away destroys it. Four of nine true secrets were being rejected before that
was fixed.

### 19.3 Two bars, not one

| where | test | why |
|---|---|---|
| **Named assignment** (`api_key = …`) | not language, not a placeholder | The name is already strong evidence; demanding high entropy too would drop short real keys for nothing |
| **Known key formats** (`AKIA…`, `ghp_`, `AIza`, `sk_live_`) | ratio ≥ 0.45 | Only rejects filler. Config templates are full of `sk_live_XXXXXXXX`, and flagging a placeholder teaches people to ignore the warning |

The permissive bar on known formats is deliberate: `AKIAIOSFODNN7EXAMPLE` is
AWS's own documentation key, reads as language, and is still worth flagging —
anything matching `AKIA[0-9A-Z]{16}` earns a warning. There is a test whose
only job is to stop that check being tightened into rejecting it.

### 19.4 What changed, and what did not

The plan proposed a new rule. There already was one — `Secret or key
assignment`, ungated, firing on `api_key = changeme` and
`token: correcthorsebatterystaple`. A duplicate was written before that was
noticed and then deleted: the gate went on the rule that existed, and its
key-name list gained `refresh_token`, `session_key` and `credential`.

Result on a 17-case discrimination set: **17/17**, from 15/17 before the
language fix and considerably worse before the gate. Corpus, document corpus,
classification and file round-trips all unchanged.

### 19.5 A deliberate limit

There is **no rule for an unnamed high-entropy blob** — a bare 40-character
base64 string sitting in prose. It would fire on hashes, content-addressed ids,
inlined images and git SHAs, and it feeds a blocking category. Named
assignments plus the shape rules are the defensible scope; recognising a secret
purely by looking random is not.

### 19.6 One live false positive found by re-reviewing the spec after the fact

The Item 10 spec arrived after the work was already done, and reading it
against what shipped turned up a real bug: **a UUID assigned to a
secret-shaped name was being reported as an API key.**

```
token = c9a646d3-9c61-4cb7-bf7d-c2ee52d9c631   ->  API_KEY
```

Entropy cannot see this. The value scores 0.725, contains no language, and is
not a placeholder — it is genuinely random, because a UUID is. The assignment
rule then outranks the `UUID` category on priority, so a correlation id became
a blocking finding. Structural exclusion is the only thing that catches it, and
the spec's `UUID_REGEX` was right.

Fixed with `looksLikeStructuredId`, and the bare `secret` key name was added
while in there (it was missing, so `secret = <hex>` found nothing).

`GIT_SHA_REGEX` was **not** adopted, on measurement: `commit = <sha>` already
finds nothing, because `commit` is not a secret-ish name and the pattern never
matches. The key name does that work. Excluding all 40-hex strings would trade
a real credential — plenty of tokens are 40 hex characters — for a hypothetical
commit hash, which is the wrong way round for a tool whose job is not missing
things. There is a test asserting the non-exclusion, so it does not get
"tidied up" later.

Three other things in the spec were not adopted, and are worth recording:

- **`rawEntropy >= 4.5` survives in the generic-ASCII branch**, behind a
  `length >= 16` gate — the same unreachable floor as before, just relocated.
  For a 16-character value the maximum is 4.0, so that branch is inert for
  every length its own gate admits. `minRaw = 4.3` in the base64 branch has
  the same problem up to 20 characters.
- **`tier: 'Certain'` set by the detector.** Tiers come from `context.ts`;
  detectors propose and never decide. That separation is what makes the engine
  testable, and a detector that assigns its own tier bypasses the confidence
  engine entirely.
- **`findGenericEntropySecrets` as a standalone function** would sit outside
  the `PatternRule` registry, so its findings would miss overlap resolution —
  which is exactly what let the UUID case outrank the `UUID` category in the
  first place.

Also: the spec's own git-SHA fixture, `e3b0c44298fc1c149afbf4c8996fb92427ae41e`,
is **39 characters**, so it does not match `/^[0-9a-f]{40}$/`. It would fall
through to the hex branch, score ~0.9 metric, and be reported as a secret — so
that test would have failed against its own implementation.

---

## 20. Phase 4.3 — allowlist and identity suppression

`src/engine/allowlist/` plus `extension/src/allowlist.ts`. 385 tests, corpus
0 FP / 0 FN, document corpus unchanged.

### 20.1 Three deviations from the spec, each for a reason

**Where it runs.** The spec says "after candidate generation and overlap
resolution, but before scoring". That point does not exist in this pipeline —
scoring happens first, and `resolveOverlaps` operates on already-scored
candidates. Suppression runs at the **candidate stage** instead, which is also
the more correct place: candidates feed the classifier, the sensitivity
assessment, entity consistency and the recoverable budget, and a suppressed
identity should be absent from all of it rather than filtered at the end having
already voted.

There is a test for precisely that. Three named companies raise the
`customer-list` sensitivity signal; suppressing the user's own employer drops
it to two and the signal must not fire. A filter over findings would have let
it fire and then hidden the company from the display.

**The hash.** The spec proposes 32-bit FNV-1a. That is not a digest — a 32-bit
space is enumerable in milliseconds, so it does not serve the stated purpose of
keeping names out of storage, and with a known salt it protects nothing. Since
the scan path is synchronous and `crypto.subtle` is not, this ships a
**synchronous SHA-256** (verified against the standard vectors, because a
hand-rolled hash that is subtly wrong would silently match nothing and the
allowlist would look merely broken).

**Domains had to become hashable.** The spec stores `domainSuffixes` as
plaintext lowercase strings while requiring "no plain text in storage" — a
contradiction it could not avoid, because a suffix test cannot be run against a
hash. Resolved by inverting it: decompose the *candidate* hostname into its own
suffixes (`api.corp.internal` → `corp.internal` → `internal`) and hash each.
Bounded at eight labels, and now domains are stored as digests like everything
else.

### 20.2 The property that matters most

**An allowlist can never silence a credential.** Nothing in the `secret` group
is suppressible, whatever a user puts in their list, and it is enforced twice —
once by an explicit category set, once by re-checking the category table so the
set cannot drift from it. Someone who pastes their own API key into an
allowlist has made a mistake and the engine must not honour it.

The spec had no equivalent guard. Its `filterAllowlistedFindings` would happily
drop a `PASSWORD` finding if its hash matched, which is a footgun aimed at
exactly what the tool exists to prevent.

### 20.3 What it costs

| | |
|---|---|
| 199-character prompt, unconfigured | 0.211 ms |
| same, 4 entries | **0.209 ms** |
| same, 502 entries | 0.269 ms |
| 291 KB document, unconfigured | 197 ms |
| same, configured | 234 ms (+19%) |

Free on the path that matters: the suppression saving offsets the hashing cost
on a realistic prompt. On a very large document, configuring it costs about a
fifth, because every identity-category candidate gets a digest — the
pathological case, not the common one. Unconfigured it returns the same array
it was given, so the default is one set-size check for the entire scan.

One measurement to distrust: an early run appeared to show cost scaling with
list size (234 ms at 3 entries, 386 ms at 201). It was a confound — the larger
list omitted one company, so 900 more candidates survived to be *scored*. Set
lookup is O(1) and list size does not enter the per-candidate path.

### 20.4 What is not built

**No settings UI.** The engine seam and the storage shape are what the
managed-policy work (4.5) needs to build against, and a preferences screen that
writes the wrong shape is harder to undo than one that does not exist. Today
the list is populated by hand or by policy; `extension/src/allowlist.ts` reads
one key from `chrome.storage.local`, and `chrome.storage.managed` is the same
read against a different namespace.

Loading is deliberately silent on failure: an absent or unreadable allowlist
suppresses nothing, which is both the safe direction and what the default
already does.

---

## 21. Phase 4.4 — reversible de-identification (engine core)

`src/engine/hydration/vault.ts`, plus carried stand-ins in `sanitize()`. 401
tests, corpus unchanged. **Engine core only** — the extension surface is a
product decision, discussed in 21.5.

### 21.1 The mode that looks safest to invert is the one that cannot be

The spec's rule is "hydration must support Consistent Nicknames and
Placeholders first". Placeholders are the one mode with no way back, and it is
not a subtle point once measured:

```
redact        "Email [EMAIL] and [EMAIL]"                 <- many-to-one
pseudonymize  "Email Email_001 and Email_002"             <- invertible
synthetic     "Email riley.nolan@example.com and ..."      <- invertible, risky
```

Every email in a document becomes the same `[EMAIL]`, so the map is
many-to-one. Nickname mode is the reversible one *because* its stand-ins are
unique.

Handled by marking a token ambiguous the moment a second distinct value claims
it, and refusing to invert it. So redact mode degrades to "nothing to restore",
which is correct, rather than to a confidently wrong answer. A single value in
redact mode is still restorable, because there it is unambiguous.

### 21.2 One regex with `\b` on both ends restores nothing in placeholder mode

Measured before writing anything:

```js
new RegExp("\\b(\\[EMAIL\\]|Person_001)\\b", "g")
"Contact [EMAIL] today".match(pattern)   // -> null
```

`\b` asserts a word/non-word transition. Before the `[` of `[EMAIL]`, preceded
by a space, both sides are non-word, so there is no boundary and no match. The
spec's single pattern hydrates nothing at all in placeholder mode, silently.

Fixed by splitting the alternation: bracketed tokens are self-delimiting and
get no assertion, bare tokens get one on each side. Two tests cover it.

The longest-first sort is also load-bearing, and for a subtler reason than the
spec gives. With the short token first, `Person_0010` is not merely
mis-restored — it is skipped entirely: the engine matches `Person_001`, the
trailing `\b` fails against the `0`, and it abandons the position rather than
trying the longer branch.

### 21.3 The secret guard has to read the category table

The spec's guard is a name test:

```ts
if (rec.category.toUpperCase().includes('SECRET') || includes('KEY')) continue
```

`PASSWORD`, `ACCESS_TOKEN` and `CONNECTION_STRING` contain neither word. All
three would enter the vault and be restored. Reproduced by regressing the
shipped guard to the spec's version:

```
AssertionError: expected 'token S3cur3!P@ssw0rd#2024x here'
                not to contain 'S3cur3!P@ssw0rd#2024x'
```

**And the two bugs mask each other.** With both present — the `\b` pattern and
the name guard — the password never comes back, because secrets are replaced
with a bracketed token that the broken regex cannot match. So the combined run
passes. Anyone shipping the spec as written would have had a latent credential
leak that only became live the day somebody fixed the regex, with no test to
notice. That is a more dangerous shape of bug than either alone.

The shipped guard checks `category(id).group === 'secret'`, which is the same
authority the allowlist uses.

### 21.4 Multi-turn stability, and not mutating a discarded result

`sanitize()` now takes an optional `carry: Pseudonyms` and returns the updated
set. Carrying the *counters* matters as much as the assignments: without them,
turn two starts counting at one again and a second person is handed a stand-in
that already belongs to somebody.

The carried state is copied rather than aliased, so a caller who sanitizes and
then throws the result away does not find its own vault already modified.
There is a test for that, because the aliasing version is the natural way to
write it and the bug it causes is invisible until two turns disagree.

`sanitize()` did not need the new result shape the spec proposes — it already
returned a `replacements` manifest carrying the finding and its replacement,
which is exactly the substitution record required. The vault is driven from
that rather than from the findings, so a value the allowlist suppressed — never
replaced, so never in need of restoring — cannot acquire an entry.

### 21.5 The surface is a product decision, not a technical one

Of the three delivery vectors in the spec, I would ship the third and
explicitly decline the second.

**Popup inspector (recommended).** The user pastes the model's answer and gets
their own words back. No site DOM is touched, no framework internals are
involved, and it needs no per-site knowledge — so it cannot break when ChatGPT
ships a redesign.

**Injected button on assistant messages.** Workable, but it mutates the site's
DOM inside a React tree, which the spec itself notes risks re-render
mismatches. Every adapter in this project deliberately avoids framework
internals; this would be the first thing that does not.

**Clipboard interception — I would not do this.** It requires listening for
`copy` on assistant output, which means the extension starts *reading model
responses*. Today it observes three user-initiated moments and nothing else,
and the README makes that claim four times. Reading the assistant's output is a
material expansion of what the tool sees, it is invisible to the user, and it
would have to be disclosed. The convenience does not pay for the claim.

**One thing the spec misses either way:** an in-memory `Map` in the service
worker will not survive. MV3 terminates the worker after roughly thirty seconds
idle, which is the *normal* gap between turns of a conversation, so the vault
would silently forget its mappings between the two turns it exists to connect.
The right home is `chrome.storage.session` — memory-only, never written to
disk, cleared when the browser closes — which satisfies the spec's own lifetime
rule and survives eviction. It is also what this project already uses for the
"Edit in AI Safe" handoff.

Session keying on `(tabId, chat id)` is right, and the tab id has to come from
`sender.tab.id` in the worker: a content script cannot know its own.

### 21.6 The surface, shipped

Popup inspector, as agreed. `extension/src/hydration.ts` for the store,
`extension/src/popup/hydrationView.ts` for the panel. 413 tests.

**Storage.** `chrome.storage.session`, keyed `vault:<tabId>:<pathname>`. Every
test in `extension/src/__tests__/hydration.test.ts` reloads from storage
between turns, because that is what a worker eviction actually does — and the
multi-turn property is meaningless unless it survives one.

**The session key is derived in the worker**, from `sender.tab.id` and
`sender.url`, and never sent by the page. Two reasons: a content script cannot
know its own tab id, and this project deliberately never lets a page hand over
a URL. The pathname is kept because a chat id lives there and is what makes
turn two the same conversation as turn one; the query string and fragment are
dropped, because that is where content ends up. There is a test asserting
`?q=our+acquisition#top` does not reach the key.

**Counters are reconstructed, not stored.** The plan's `SerializedVaultSession`
carries `counters` but no assignment map, which would break reuse on eviction —
turn two would not know that `Sarah Mitchell` is already `Person_001`. Rather
than store both representations of the same fact across a serialisation
boundary, the assignments *and* the counters are derived from the entries: the
entry list is `token -> value + category`, and the counter is the highest
numeric suffix seen. Tested by asserting the third person in a conversation is
not handed a stand-in belonging to the first.

**Deviations in the UI code.** Built with DOM calls rather than `innerHTML`: a
restored value is user data and may contain anything, and interpolating it into
markup is how that becomes an injection. The plan's markup also used Tailwind
utility classes (`text-muted-foreground`, `bg-primary`) which do not exist in
this popup — it has its own 40-line dark stylesheet — so the panel is styled to
match what is there.

The panel is **hidden entirely** when there is nothing to restore, for the same
reason the banner is: silence is the normal case, and a surface that is always
present but usually empty is noise. It also renders on its own await chain
rather than inside the status callback, so somebody whose worker has died can
still get their names back while the status line reports the checker
unavailable.

Restored text is **selected, not copied**. Writing to the clipboard would need
a permission this extension deliberately does not hold, and the user should be
the one who copies their own data.

**Ambiguity is tracked across turns, not only within one.** Two separate
sanitizations that both produce `[EMAIL]` for different addresses mark the
token ambiguous on the second — the entries are merged into the stored session
rather than replacing it. Tested, because the single-turn version passes
without it.

---

## 22. Phase 4.5 — managed policy deployment

`extension/managed_schema.json`, `extension/src/managed.ts`, and a policy
registry in the engine. 427 tests, corpus unchanged.

### 22.1 The schema had to speak the engine's vocabulary

The plan states this goal and then does not meet it. Its mapping table targets
`Policy['mode']` and `Policy['blockedCategories']`, neither of which exists:
`Policy` is four groups — `secret`, `personal`, `confidential`, `internal` —
each holding a `Decision` of `allow`, `warn` or `block`, plus an uncertainty
ceiling and an engine-unavailable rule. There is no mode field and no set of
blocked categories.

`BlockedCategories: ['secret', 'pii']` is also lossy in a way that matters: it
can express block-or-not, and the engine's third state is *warn*, which is what
the product actually does most of the time. And `pii` is not an engine word.

So the schema exposes the four groups directly, one key each, and mapping is
assignment rather than interpretation. `ExecutionMode` is kept — an admin who
wants audit mode should not have to set six keys — but it selects a **base**
that the per-group keys then override, rather than being a parallel concept.
That composition turns out to be what makes 22.3 work.

### 22.2 Merging both digest lists breaks domain matching

The plan maps `AllowlistDomainDigests` into `AllowlistConfig['exactHashes']`,
alongside the value digests. Domain suppression works by decomposing a
candidate hostname into its own suffixes and hashing each, then looking them up
in `domains` — so a domain digest sitting in `values` would only ever match if
the whole hostname had been listed. `corp.internal` would stop covering
`api.corp.internal`, which is the entire point of it. There is a test asserting
the subdomain case against a policy-pushed list.

### 22.3 `OBSERVE_ONLY` was misnamed, so it was fixed

`OBSERVE_ONLY` had `secret: 'warn'`. Its own test was called "observe-only
never interrupts" and asserted `decision === 'warn'` — which *is* an
interruption. The name and the value disagreed, and the test documented the
disagreement rather than catching it.

Changed to allow everything. A mode called "observe only" that still puts a
banner up is misnamed, and the surprise costs more than the warning gains — and
the reasonable middle now composes exactly and says what it does:
`ExecutionMode: OBSERVE_ONLY` with `Secret: warn`. There is a test for that
composition, and the schema documents it.

This is also what lets the page be left alone. `observeOnly` is **derived** —
true when no group can produce anything but `allow` — rather than read from the
mode name, so the flag reflects what the policy can actually do. The content
script fetches it once at load and skips holding the send entirely, because
holding a keystroke and then releasing it is still holding it, and an
organisation running an audit has asked for the page not to be touched.

### 22.4 Two things a policy cannot do

**It cannot make a credential suppressible.** The allowlist refuses the
`secret` group whatever is listed, so an administrator cannot switch off
credential detection through a policy push, by accident or otherwise. Tested
against a managed list containing an AWS key.

**An unrecognised value is ignored, never coerced.** `Secret: 'BLOCK'`,
`Personal: 'quarantine'` and `Internal: true` all fall back to the default
rather than to `allow`. A policy is pushed by somebody who cannot see the
result, so a typo must fail safe. The plan's resolver coerces
`ExecutionMode` with `=== 'OBSERVE_ONLY' ? ... : DEFAULT`, which is safe by
accident, and passes `BlockedCategories` straight through unvalidated, which is
not.

### 22.5 Two allowlists, not one merged set

An organisation cannot know the salt a user's list was built with, and a user
cannot be handed the organisation's. A digest only means anything against the
salt it was made with, so the engine now holds a **list** of allowlists and
evaluates against each in turn. One config with one salt cannot express it —
the plan notices the problem ("accounting for salt differences") but its type
has a single `salt` field.

`AllowUserOverrides: false` drops the user's list entirely, which is the point
of the setting.

### 22.6 A policy registry, for the same reason as the others

`DEFAULT_POLICY` was hardcoded at five call sites across the worker, the
offscreen document and the two-stage comparison. A managed policy has to reach
all five, and an argument threaded through every one of them is an argument
that will eventually be forgotten at one — so `registerPolicy`/`getPolicy` now
sit beside the confirmer, the metrics sink and the allowlist registries. Same
shape, same reason.

---

## 23. Phase 3 revisited — the one item that was still open

Phases 3, 4 and 5 of the revised checklist were already complete: the content
test bed and hold-reissue hardening in §16.2 and `intercept.test.ts`, Layer 0
normalisation in §15, and file interception in §16 and §17. Of the three
vulnerabilities the checklist restates, two were fixed then. The third was not,
and it was the one I had left.

### 23.1 The length threshold was hiding real findings

`< 12` was mine, chosen as a round number, and it was wrong. Measured against
the engine:

| text | chars | found |
|---|---|---|
| `a@b.c` | 5 | **EMAIL** |
| `a@b.co` | 6 | **EMAIL** |
| `x@y.com` | 7 | **EMAIL** |
| `+27825550198` | 12 | PHONE |
| `AKIAIOSFODNN7EXAMPLE` | 20 | API_KEY |
| `pw=hunter2` | 10 | nothing |

So the shortest thing the engine can flag is a **five-character** email
address, and "what domain is x@y.com?" was crossing the submit boundary
unchecked. Sending an address on its own is an ordinary prompt.

Now 4 — deliberately *below* the engine's real minimum rather than at it — and
`intercept.test.ts` asserts the **relationship** rather than the number: it
scans the shortest known findings and requires each to be at least
`MIN_CHARS`. A future rule that can match something shorter fails the build
instead of quietly slipping past the gate. Regressing the constant to 12 fails
two tests.

Not taken to zero, as the checklist proposes. Every send would then pay a
worker round trip, and "yes", "thanks" and "continue" are most of what people
type. Four costs nothing and hides nothing.

### 23.2 The epoch guard was measured against the current one, and not adopted

The checklist proposes replacing text-bound approval with
`WeakMap<Element, epoch>` plus single-use consumption — approval by element
identity, text-independent. It would immunise against any editor rewrite
whatsoever, which is a real advantage. So the question is whether the current
guard actually fails on one, and it was cheaper to find out than to argue.

Six synchronous rewrites, applied on `input` after cleaning, then a second
send. Re-prompts, where 0 means the guard held:

| rewrite | re-prompts |
|---|---|
| non-breaking spaces for spaces | 0 |
| trailing newlines | 0 |
| whitespace collapsed | 0 |
| wrapped in quotes | 0 |
| leading bullet | 0 |
| appended zero-width space | 0 |

All six. Two mechanisms carry it: after cleaning, **both** the requested string
and the read-back are approved, and the read-back is taken after the editor's
synchronous rewrite — so any synchronous transformation is covered whatever it
does. Whitespace normalisation then covers the asynchronous case, which was
also measured: a React-style editor committing on a later tick, where the
read-back sees text the editor has not touched yet, still produced 0.

So **not adopted.** The residual hole is a non-whitespace *asynchronous*
rewrite — an editor that adds quotes or bullets a tick after being written to,
which is not a thing editors do; they normalise whitespace and markup
structure, not content. Against that narrow and hypothetical gap, the epoch
design gives up something real: approval stops being bound to the text that
was approved, so a resend carrying different content than what the user
cleared would pass unchecked. For a tool whose job is not missing things, text-
bound approval is the safer trade.

All seven rewrites are now regression tests, so the boundary is documented
rather than assumed.

### 23.3 One correction to the checklist's fail-safe

`try { ... } finally { if (!actionTaken) resend() }` resends whenever no action
was recorded — including when a banner is on screen and simply has not been
answered yet. The shipped version releases the send only when `bannerIsOpen()`
is false: if a banner did make it up, the user has the controls and it is
theirs to resolve, not ours to send behind them. That distinction has its own
test (`leaves the decision alone when a banner did make it up`), which the
checklist's version would fail.
