/**
 * Contextual vocabulary for the confidence engine.
 *
 * The gazetteers in `gazetteer.ts` answer "could this be an entity?". These
 * lists answer "does the surrounding language actually support that reading?"
 * — including, importantly, the evidence *against* it.
 */

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

/**
 * Given names that are also ordinary English words. A single bare token from
 * this list is not evidence of a person on its own — it needs corroboration.
 * This is the main defence against "Christian values", "Grace period",
 * "Mark the invoice" and "the May release".
 */
export const AMBIGUOUS_GIVEN_NAMES = words(`
christian mark may june april august will bill frank grace faith hope art
summer autumn winter victor victoria rose joy pearl robin ray dawn sunny
rich guy miles chase drew mercy blessing precious gift angel king earl duke
sky river brook heather ivy jasmine lily olive daisy holly sage hunter
carter mason cooper parker forrest star honour honor prudence patience
charity felicity destiny harmony melody serenity justice liberty amber ruby
crystal jade coral scarlet violet hazel dale glen heath moss reed stone
wood banks field marsh ford price bond cash coin penny mint sterling noble
young long short brown white green black gray grey small best love chance
luck win victory peace story page book bell drum harp major minor mission
rusty buck chip curt dick don ernest jack jean lane max nick pat pip rob
sonny wade ward web wilder rey unity trinity genesis journey legend
`)

/**
 * Verbs that a person plausibly performs. A capitalised token immediately
 * followed by one of these is very likely a subject — "Christian joined",
 * "Mark reviewed". Copulas (is/are/was/were) are deliberately excluded: they
 * follow ordinary nouns just as happily ("Hope is not a strategy").
 */
export const PERSON_VERBS = words(`
joined said says asked asks called calls phoned emailed emails wrote writes
replied replies responded responds reported reports raised raises logged
logs escalated escalates confirmed confirms approved approves signed signs
agreed agrees requested requests mentioned mentions noted notes added adds
sent sends forwarded attached left leaves arrived attends attended needs
needed wants wanted will would should could can shall must has had have
works worked manages managed owns owned runs ran took gave made found fixed
closed opened updated reviewed reviews checked tested deployed complained
chased followed flagged spotted suggested recommended advised explained
clarified apologised apologized thinks thought believes feels plans planned
booked scheduled cancelled canceled accepted declined rejected resolved
investigated contacted spoke met visited returned started stopped finished
completed submitted uploaded downloaded shared did does do went came saw
knows knew told tells gets got gives takes gone gets handled reopened
`)

/**
 * Function words. A capitalised ambiguous token followed by one of these is
 * behaving as a verb or a modifier, not as a subject — "Mark the invoice",
 * "Will the job run", "Faith in the process", "May we schedule".
 */
export const FUNCTION_FOLLOWERS = words(`
the a an this that these those of and or to in on at for with we you they
it he she i my our your their its his her there here if when while but so
then than as by into onto about after before during per via across around
over under between within without upon unless until because although
`)

/**
 * Everyday nouns. A capitalised ambiguous token followed by one of these is
 * almost always a modifier — "Christian values", "Grace period", "Summer
 * release", "the London office".
 */
export const COMMON_NOUN_FOLLOWERS = words(`
values value feedback period release releases notes note discussion
discussions conditions condition policy policies process processes report
reports data information results result issue issues request requests
ticket tickets plan plans strategy roadmap pricing price prices cost costs
budget time times day days week weeks month months year years quarter
morning afternoon evening deadline target targets level levels service
services support quality standard standards practice practices principle
principles belief beliefs tradition traditions holiday holidays break
season weather garden flower flowers stage court park bridge street road
hall house room meeting meetings call calls session sessions review reviews
update updates version versions edition mode type types case cases list
lists table tables chart charts figure figures number numbers rate rates
share shares market markets growth revenue margin margins sales spend
forecast pipeline deal deals contract contracts term terms clause section
chapter pages line lines item items point points area areas region regions
site sites office offices team teams department departments group groups
project projects product products feature features function functions
system systems server servers network networks database databases
application applications platform platforms tool tools solution solutions
approach approaches method methods model models framework frameworks
template templates guide guides manual manuals document documents file
files folder folders record records entry entries log logs event events
alert alerts error errors warning warnings failure failures incident
incidents problem problems risk risks control controls measure measures
metric metrics indicator indicators score scores rating ratings ranking
edition scheme schemes phase phases stream streams track tracks window
windows cycle cycles round rounds wave waves batch batches run runs
workload workloads agent agents wildcard wildcards trap traps class classes
tracker termination backup backups restore restores job jobs snapshot
snapshots repository repositories replica replicas retention appliance
console dashboard portal wizard installer patch patches hotfix build builds
`)

/**
 * Role context that follows a person: "Rose from the finance team",
 * "Priya in operations". Checked before the follower penalties so a
 * preposition here is read as support, not as a function word.
 */
export const ROLE_CONTEXT_RE =
  /^\s+(?:from|in|of|on|at)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:team|teams|department|dept|office|desk|group|division|unit|side|accounts|accounting|finance|sales|support|marketing|engineering|operations|ops|legal|procurement|payroll|hr|it|security|billing|logistics)\b/

/** A job title in parentheses or after a comma: "Sarah Mitchell, Account Manager". */
export const JOB_TITLE_RE =
  /^\s*[,(]\s*(?:senior|junior|lead|head|chief|principal|associate|assistant|deputy|acting|global|regional)?\s*(?:account|sales|support|service|technical|solutions|customer|project|product|programme|program|delivery|operations|finance|hr|it|security|marketing|field|pre-sales|presales)?\s*(?:manager|director|engineer|architect|consultant|specialist|analyst|administrator|admin|lead|officer|executive|president|partner|advisor|adviser|representative|rep|coordinator|supervisor|technician|developer|designer|owner|scientist)\b/i

/** Preceded by a determiner or preposition: "the May release", "for June". */
export const DETERMINER_BEFORE = words(`
the a an this that these those our your their its his her every each any
some no for in on at to of by with from about during per via
`)

/** Locative prepositions — positive evidence for a place, negative for a person. */
export const LOCATIVE_BEFORE = words(`
in at from near to towards outside inside around via between
`)

/** Company ownership context that follows the name: "Amazon is our customer". */
export const ORG_OWNERSHIP_RE =
  /^\s+(?:is|are|remains|became|has been)\s+(?:one of\s+)?(?:our|a|an|the|their)\s+(?:largest\s+|biggest\s+|key\s+|new\s+|existing\s+|current\s+|main\s+|top\s+)?(?:customer|client|partner|reseller|vendor|supplier|tenant|account|prospect|distributor)\b/i

/** Link paths that indicate ordinary public documentation, not a secret. */
export const PUBLIC_URL_PATHS = words(`
legal privacy terms policy policies about contact support help docs
documentation guide guides blog news press careers pricing product products
features download downloads faq kb article articles community forum status
`)

// ---------------------------------------------------------------------------
// Company-confidential vocabulary. Grouped so the document assessment can
// require several *different* kinds of signal rather than one repeated word.
// ---------------------------------------------------------------------------

export interface TopicGroup {
  id: string
  label: string
  terms: string[]
}

export const CONFIDENTIAL_TOPICS: TopicGroup[] = [
  {
    id: 'roadmap',
    label: 'unreleased product plans',
    terms: [
      'roadmap',
      'milestone',
      'general availability',
      'ga date',
      'release schedule',
      'release plan',
      'backlog',
      'epic',
      'sprint',
      'launch date',
      'unreleased',
      'not yet released',
      'private beta',
      'closed beta',
      'early access',
      'eap',
      'tech preview',
      'upcoming release',
      'next version',
      'next release',
      'target release',
      'ship date',
      'feature flag',
      'deprecation plan',
      'sunset',
      'end of life',
      'phase 2',
      'phase two',
    ],
  },
  {
    id: 'architecture',
    label: 'internal architecture',
    terms: [
      'high-level design',
      'low-level design',
      'design document',
      'architecture diagram',
      'data flow',
      'internal api',
      'service mesh',
      'topology',
      'failover design',
      'replication design',
      'sequence diagram',
      'component diagram',
      'infrastructure diagram',
      'database schema',
      'tech stack',
      'system design',
      'reference architecture',
      'proprietary algorithm',
    ],
  },
  {
    id: 'pricing',
    label: 'pricing detail',
    terms: [
      'price list',
      'list price',
      'rate card',
      'cost price',
      'gross margin',
      'net margin',
      'discount',
      'uplift',
      'quota',
      'commission',
      'floor price',
      'deal desk',
      'pricing model',
      'tiered pricing',
      'transfer price',
      'margin',
    ],
  },
  {
    id: 'strategy',
    label: 'business strategy',
    terms: [
      'go-to-market',
      'gtm',
      'competitive analysis',
      'competitor analysis',
      'battlecard',
      'win rate',
      'market share',
      'positioning',
      'differentiation',
      'swot',
      'business case',
      'board pack',
      'board paper',
      'five-year plan',
      'three-year plan',
      'strategic plan',
      'acquisition target',
      'restructure',
    ],
  },
  {
    id: 'financial',
    label: 'internal financials',
    terms: [
      'forecast',
      'sales pipeline',
      'arr',
      'mrr',
      'churn',
      'bookings',
      'revenue target',
      'ebitda',
      'p&l',
      'budget variance',
      'headcount plan',
      'run rate',
      'burn rate',
      'attach rate',
    ],
  },
  {
    id: 'security',
    label: 'security architecture',
    terms: [
      'threat model',
      'attack surface',
      'penetration test',
      'pen test',
      'vulnerability report',
      'security architecture',
      'incident response plan',
      'key rotation',
      'firewall rule',
      'firewall rules',
      'access matrix',
      'privileged access',
    ],
  },
  {
    id: 'process',
    label: 'internal process',
    terms: [
      'internal process',
      'runbook',
      'playbook',
      'standard operating procedure',
      'escalation matrix',
      'on-call rota',
      'on-call rotation',
      'internal only',
      'internal use',
    ],
  },
]

/**
 * Explicit classification markers. Strong, but never sufficient on their own —
 * "confidentiality policy" is usually a public HR document, which is why the
 * pattern refuses to match that phrasing.
 */
export const CONFIDENTIAL_MARKER_RE =
  /\b(?:strictly\s+)?confidential(?!ity\s+(?:policy|agreement|statement|clause|notice|undertaking))\b|\binternal use only\b|\bnot for (?:external )?distribution\b|\bdo not (?:share|distribute|forward)\b|\bcompany confidential\b|\bproprietary and confidential\b|\brestricted\b/gi

/** Language typical of material that is already public. */
export const PUBLIC_MARKER_RE =
  /\bpress release\b|\bfor immediate release\b|\bpublicly available\b|\bpublished\b|\bdatasheet\b|\ball rights reserved\b|\bterms of service\b|\bprivacy policy\b|\bconfidentiality policy\b|\buser guide\b|\bknowledge base\b|\bhelp cent(?:re|er)\b|\bavailable to all customers\b|\bgenerally available\b/gi

/**
 * A classification word in the *filename* is a deliberate act of labelling by
 * whoever saved the file — different in kind from incidental vocabulary in the
 * body, so it counts towards the marker family rather than metadata.
 */
export const FILENAME_MARKER_RE =
  /\b(?:internal|confidential|restricted|private|nda|do[-_ ]?not[-_ ]?(?:distribute|share|forward))\b/i

/** Filename hints. A file called "Q4 roadmap - internal.docx" says a lot. */
export const CONFIDENTIAL_FILENAME_RE =
  /roadmap|strategy|strategic|pricing|price[-_ ]?list|rate[-_ ]?card|internal|confidential|restricted|forecast|board|pipeline|budget|margin|competitive|battlecard|nda|q[1-4][-_ ]?(?:fy)?\d{2,4}|fy\d{2,4}|do[-_ ]?not[-_ ]?distribute/i

/**
 * Section and worksheet names. Deliberately excludes the bare classification
 * words: a heading that just says "CONFIDENTIAL" is the *same* evidence the
 * marker signal already counted, and counting it twice would let a single
 * keyword classify a document on its own.
 */
export const CONFIDENTIAL_SECTION_RE =
  /roadmap|strategy|strategic|pricing|price[-_ ]?list|rate[-_ ]?card|forecast|board pack|pipeline|budget|margin|competitive|battlecard|q[1-4][-_ ]?(?:fy)?\d{2,4}|fy\d{2,4}/i
