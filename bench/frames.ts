/**
 * Frames and entity pools for the generated document corpus.
 *
 * ## Why this exists
 *
 * The two benchmarks that came before it cannot see a whole class of change.
 * `check:corpus` calls the synchronous `scan()`, so it never escalates and
 * cannot detect anything about the confirmer. Both held-out ambiguity sets are
 * one sentence per case, so window merging never activates on them — and they
 * duly reported "no change" for a merge cap that loses three findings in
 * thirteen on a dense document. An instrument that cannot see the thing you
 * are changing is worse than no instrument, because it produces a number.
 *
 * So this corpus is **documents**, each holding several labelled candidates at
 * varying density. That is the only shape that exercises windowing, merging,
 * batching and the entity-consistency pass.
 *
 * ## Frame families, and why the split is by family
 *
 * Every frame belongs to a family — the *kind* of evidence it presents, not the
 * words it uses. Scoring holds out whole families rather than random cases, so
 * the number answers "does this generalise to sentence shapes it has never
 * seen" rather than "does this generalise to names it has never seen". The
 * second question is much easier and the engine already passes it.
 *
 * ## What this is not
 *
 * Not real data. Frames are written by hand, so the corpus can only contain
 * text shapes somebody thought of, and a generated set is never evidence that
 * the engine handles prose nobody imagined. It is an instrument for detecting
 * *regression* and for comparing two configurations, which is exactly what was
 * missing. The honest number for absolute accuracy is still a fresh held-out
 * set written by someone else.
 */

export type Label = 'PERSON' | 'ORGANISATION' | 'LOCATION' | null

export interface Frame {
  /** Stable id, so a failure can be traced to the sentence shape. */
  id: string
  /** The evidence family. Held out as a unit. */
  family: string
  /** `{}` marks the slot. */
  template: string
  /** What the slot is, or null when it must not be flagged at all. */
  label: Label
  /** Which pool the slot is filled from. */
  pool: PoolName
}

export type PoolName =
  | 'diverseNames'
  | 'angloNames'
  | 'everydayNames'
  | 'organisations'
  | 'places'
  | 'commonWords'

// ---------------------------------------------------------------------------
// Entity pools
// ---------------------------------------------------------------------------

/**
 * Names no gazetteer contains. The documented reason a model is in this
 * product at all, so they carry the most weight in any comparison.
 */
export const diverseNames = [
  'Adeyemi Olatunji', 'Thandeka Mokoena', 'Chukwuemeka Okonjo',
  'Aarav Krishnamurthy', 'Kavita Radhakrishnan', 'Nguyen Van Duc',
  'Tariq Al-Mansoor', 'Siti Nurhaliza', 'Oyelaran Babatunde',
  'Mateo Fernández', 'Yuki Takahashi', 'Björn Þorvaldsson',
  'Lwazi Ndlovu', 'Farhana Chowdhury', 'Dimitrios Papadopoulos',
  'Ayşe Demirkan', 'Rustam Nazarov', 'Chidinma Eze',
  'Wanjiru Kamau', 'Prakash Venkataraman',
]

export const angloNames = [
  'Sarah Mitchell', 'David Okafor', 'James Whitfield', 'Emma Thornton',
  'Michael Brennan', 'Laura Pemberton', 'Daniel Ashworth', 'Rachel Kingsley',
]

/**
 * Words that are also ordinary English. Whether each is a person depends
 * entirely on the frame, which is the whole point — these are where precision
 * and recall are actually paid for.
 */
export const everydayNames = [
  'Grace', 'May', 'Frank', 'Hope', 'Faith', 'Miles', 'Robin', 'Justice',
  'Pearl', 'Sterling', 'Sage', 'Dawn', 'Ivy', 'Carter', 'Ford', 'Hunter',
  'Major', 'Patience', 'Penny', 'Bond', 'Chase', 'Christian', 'Mark', 'Rose',
]

export const organisations = [
  'Nokia Bell Labs', 'Hyundai', 'Meridian Logistics', 'Brightwater Holdings',
  'Kestrel Analytics', 'Northwind Trading', 'Voltara Systems', 'Cascadia Freight',
]

export const places = [
  'Johannesburg', 'Rotterdam', 'Kuala Lumpur', 'Reykjavík',
  'Guadalajara', 'Thessaloniki', 'Chittagong', 'Novosibirsk',
]

/** Fillers for the trap frames — never entities, whatever their position. */
export const commonWords = [
  'Values', 'Progress', 'Quality', 'Delivery', 'Compliance', 'Strategy',
  'Onboarding', 'Retention', 'Throughput', 'Coverage',
]

export const POOLS: Record<PoolName, string[]> = {
  diverseNames,
  angloNames,
  everydayNames,
  organisations,
  places,
  commonWords,
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

const person = (id: string, family: string, template: string, pool: PoolName): Frame =>
  ({ id, family, template, label: 'PERSON', pool })

const notEntity = (id: string, family: string, template: string, pool: PoolName): Frame =>
  ({ id, family, template, label: null, pool })

/**
 * Positive families. Each presents one *kind* of evidence, so holding a family
 * out removes that evidence type entirely from training.
 */
const POSITIVE: Frame[] = [
  // --- a cue word before the name ----------------------------------------
  person('cue-contact', 'cue-word', 'Please contact {} about the renewal.', 'diverseNames'),
  person('cue-regards', 'cue-word', 'Kind regards, {}, Support Team.', 'diverseNames'),
  person('cue-cc', 'cue-word', 'I have copied {} on this thread.', 'angloNames'),
  person('cue-attn', 'cue-word', 'Attention: {}, second floor.', 'everydayNames'),
  person('cue-spoke', 'cue-word', 'I spoke to {} earlier this week.', 'everydayNames'),

  // --- a verb only a person performs -------------------------------------
  person('verb-joined', 'person-verb', '{} joined the review yesterday.', 'diverseNames'),
  person('verb-approved', 'person-verb', '{} approved the change overnight.', 'angloNames'),
  person('verb-raised', 'person-verb', '{} raised the ticket this morning.', 'everydayNames'),
  person('verb-signed', 'person-verb', '{} signed the handover document.', 'diverseNames'),
  person('verb-escalated', 'person-verb', '{} escalated the case to support.', 'everydayNames'),

  // --- a role or department after the name --------------------------------
  person('role-from', 'role-after', '{} from procurement will sign it off.', 'everydayNames'),
  person('role-in', 'role-after', '{} in finance handles the invoices.', 'angloNames'),
  person('role-comma', 'role-after', '{}, the account manager, is away.', 'diverseNames'),
  person('role-lead', 'role-after', '{} is the migration lead this quarter.', 'diverseNames'),

  // --- a title before the name --------------------------------------------
  person('title-dr', 'title', 'Dr {} reviewed the incident report.', 'angloNames'),
  person('title-ms', 'title', 'Ms {} chaired the meeting.', 'everydayNames'),
  person('title-prof', 'title', 'Prof {} published the paper.', 'diverseNames'),

  // --- possessive ---------------------------------------------------------
  person('poss-report', 'possessive', "{}'s report is attached to the case.", 'diverseNames'),
  person('poss-team', 'possessive', "{}'s team completed the rollout.", 'everydayNames'),

  // --- an email in the same document corroborates the name ----------------
  person('email-same', 'email-corroborated', 'Ask {} — reachable on {slug}@example.com.', 'angloNames'),
  person('email-diverse', 'email-corroborated', 'Forward it to {} at {slug}@example.com.', 'diverseNames'),

  // --- a bare name with almost no support (the hard recall case) ----------
  person('bare-copy', 'unsupported', 'Please copy {} on the reply.', 'diverseNames'),
  person('bare-and', 'unsupported', 'The attendees were {} and two others.', 'diverseNames'),
]

/**
 * Trap families. Every one of these is a word that looks like a name in a
 * position where it is not one, and each is a documented false-positive shape.
 */
const NEGATIVE: Frame[] = [
  // --- a determiner before it --------------------------------------------
  notEntity('det-the', 'determiner', 'The {} release slipped by a fortnight.', 'everydayNames'),
  notEntity('det-a', 'determiner', 'We agreed a {} clause in the contract.', 'everydayNames'),

  // --- a common noun after it --------------------------------------------
  notEntity('noun-values', 'common-noun-after', '{} values guided the whole review.', 'everydayNames'),
  notEntity('noun-report', 'common-noun-after', '{} coverage improved this quarter.', 'commonWords'),

  // --- a function word after it, so it is a verb or an adjective ---------
  notEntity('func-the', 'function-word-after', '{} the invoice before Friday.', 'everydayNames'),
  notEntity('func-up', 'function-word-after', '{} up the remaining tickets.', 'everydayNames'),

  // --- capitalised only because it starts a sentence ---------------------
  notEntity('sent-initial', 'sentence-initial', '{} is measured every fortnight.', 'commonWords'),
  notEntity('sent-heading', 'sentence-initial', '{} remains the main constraint.', 'commonWords'),

  // --- ordinary vocabulary in an ordinary place -------------------------
  notEntity('vocab-mid', 'plain-vocabulary', 'We reviewed the {} process again.', 'commonWords'),
  notEntity('vocab-list', 'plain-vocabulary', 'Themes were {} and throughput.', 'commonWords'),
]

/** Filler that contains nothing at all, to vary candidate density. */
export const FILLER = [
  'The nightly job completed normally and nothing else of note occurred.',
  'No further action is required before the next review.',
  'Throughput held steady across the reporting window.',
  'The change was applied during the agreed maintenance slot.',
  'Notes from the previous session were circulated in advance.',
]

export const FRAMES: Frame[] = [...POSITIVE, ...NEGATIVE]

/** Every family, in a stable order, so a split is reproducible. */
export const FAMILIES = [...new Set(FRAMES.map((f) => f.family))].sort()

/**
 * Families reserved for validation.
 *
 * These matter for *future* tuning, not for today's numbers: the engine was
 * built before this corpus existed, so every family is equally unseen right
 * now. The split exists so that anyone who calibrates a threshold against this
 * corpus has a slice they did not fit to — and so the score can say whether a
 * change generalises to a kind of evidence it was not shown, rather than to a
 * name it has not seen. The second question is much easier and the engine
 * already passes it.
 *
 * One positive family, one trap family, one recall family — so holding them
 * out removes a whole evidence type in each direction.
 */
export const HELD_OUT_FAMILIES = ['possessive', 'function-word-after', 'unsupported']
