# AI Safe — local prompt sanitizer

Check anything for personal, internal or secret information **before** you paste
it into ChatGPT, Copilot or Gemini.

Paste text or drop a file → see what is risky → clean it in one click → improve
the prompt → copy or download the result. The whole thing runs inside the
browser tab.

```
Paste / Drop  →  Check  →  Understand  →  Clean  →  Improve  →  Copy / Export
```

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
| `npm run check` | Type-check, lint, and run both engine smoke tests |
| `npm run check:engine` | Print what the detector finds on the demo prompt, all three cleaning modes, and a false-positive sample |
| `npm run check:files` | Round-trip every sample file: extract → scan → clean → re-open the cleaned copy → re-scan for leaks |
| `npm run samples` | Regenerate the demo files in `samples/` |

## Why the privacy claim holds

The app is a static front end with no back end. After the page loads it makes
**no network requests at all** — there is no server to send anything to. File
parsing, detection, sanitization and prompt improvement are all plain
TypeScript running in the tab, and nothing is written to disk or to
`localStorage`. You can verify this with the browser's network tab: scan a
document and watch it stay empty.

That constraint drove two deliberate design choices:

- **No cloud model for detection.** Sending your text to an API to find the PII
  in it would leak exactly what the tool exists to protect.
- **No cloud model for prompt improvement either.** The improver is
  rule-based, so it is instant, predictable in a demo, and has nowhere to send
  anything. It only ever sees the *sanitized* text — the original is not passed
  to it.

## How detection works

Three independent layers run over the text and their results are merged, so no
single technique is load-bearing.

| Layer | File | What it catches |
| --- | --- | --- |
| 1 — deterministic rules | `src/engine/detectors/patterns.ts` | Emails, phone numbers, IPs, MACs, URLs, UUIDs, card numbers (Luhn-checked), IBANs, ID numbers, AWS / GitHub / Slack / Google / Stripe / model-provider keys, JWTs, bearer tokens, PEM private keys, connection strings, `password = …` assignments |
| 2 — local entity recognition | `src/engine/detectors/entities.ts` | People, companies, places, street addresses |
| 3 — business patterns | `src/engine/detectors/business.ts` | Internal server and domain names, network shares, customer / case / contract / employee numbers, licence keys, internal project names |

Layer 2 is a compact gazetteer plus context cues rather than a neural NER
model. That is a deliberate trade: it is a few tens of kilobytes of word lists,
runs in well under a millisecond, and needs no download, no GPU and no network
— which is what "local-first" has to mean on a normal business laptop.
Detectors are registered in `src/engine/detect.ts` behind a one-function
`Detector` interface, so a GLiNER or spaCy backend can be added as a fourth
layer without touching anything else.

Overlapping claims are resolved by category priority, then match length, then
confidence — so `4111 1111 1111 1111` is a card number rather than a phone
number, and `\\BKP-REPO-01\archive` is one network path rather than two
hostnames.

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

- **Excel** — sheets, rows and cell types are preserved; only cell values
  change.
- **Word** — replacements are made run by run so bold/italic formatting
  survives. If a sensitive value is split across runs (Word does this often),
  that one paragraph falls back to a collapsed rewrite, so nothing can slip
  through a formatting boundary.
- **PDF** — text is extracted and scanned, and the cleaned copy is delivered as
  `.txt`. Rewriting PDF layout reliably is out of scope.

`npm run check:files` proves the round trip: it re-opens each cleaned file and
re-scans it, and reports any value that leaked.

## Project layout

```
src/
  engine/            pure, dependency-free, no I/O
    categories.ts    every category: label, severity, placeholder, why
    detect.ts        detector registry + overlap resolution
    risk.ts          scoring
    sanitize.ts      redact / pseudonymize / synthetic
    improve.ts       local rule-based prompt rewriting
    gazetteer.ts     name, place, org and infrastructure word lists
    detectors/       the three layers
  files/             extraction and cleaned-file writing
  components/        UI (shadcn/ui + Tailwind v4)
scripts/             smoke tests and sample-file generation
samples/             fictional demo files — drag these onto the app
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

The layer-2 recogniser is the honest weak point: a gazetteer will miss an
unusual name that a neural NER model would catch. It is tuned to prefer a
false positive over a miss, and every detection can be switched off by hand in
**View details**.
