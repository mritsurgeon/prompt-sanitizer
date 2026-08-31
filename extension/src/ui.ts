import type { CheckResponse, DeepCheckResponse, WireFinding } from './protocol'

/**
 * The in-page banner.
 *
 * Everything lives inside a shadow root with its own styles, so the AI site's
 * CSS cannot reach it and it cannot reach the site's. It is a strip anchored
 * above the composer, not a modal — a modal in the middle of somebody's
 * sentence is exactly the behaviour that gets a safety tool disabled.
 *
 * ## It must not feel like an obstacle
 *
 * The tone is a seatbelt light, not a security desk. Concretely that means:
 *
 *  - It appears only when something was actually found. Silence is the normal
 *    case and it has to stay completely silent.
 *  - The primary action always moves the user *forward* — clean it and send —
 *    never "you may not do this".
 *  - The closer look happens behind an already-visible banner and updates it
 *    in place. Nothing waits on a spinner before the user can act.
 *  - Escape dismisses, and dismissing is always allowed.
 *
 * No framework. A banner with four buttons does not need one, and a content
 * script that ships React is a content script that slows down every page it
 * touches.
 */

const STYLE = `
  :host { all: initial; }
  .wrap {
    position: fixed;
    z-index: 2147483647;
    left: 50%;
    transform: translateX(-50%);
    bottom: 96px;
    width: min(680px, calc(100vw - 32px));
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #eef1f6;
    background: #171b22;
    border: 1px solid #2b323d;
    border-radius: 14px;
    box-shadow: 0 20px 60px -20px rgba(0,0,0,.7), 0 2px 8px rgba(0,0,0,.3);
    overflow: hidden;
    animation: rise .18s cubic-bezier(.22,1,.36,1) both;
  }
  @keyframes rise { from { opacity:0; transform: translateX(-50%) translateY(8px);} to {opacity:1;} }
  @media (prefers-reduced-motion: reduce) { .wrap { animation: none; } }

  .top { display:flex; gap:12px; align-items:flex-start; padding:14px 16px; }
  .dot { width:9px; height:9px; border-radius:50%; margin-top:6px; flex:none; }
  .block .dot { background:#f2705c; box-shadow:0 0 10px #f2705c; }
  .warn  .dot { background:#e8c455; box-shadow:0 0 10px #e8c455; }
  .ok    .dot { background:#3ad57f; box-shadow:0 0 10px #3ad57f; }

  .headline { font-size:14px; font-weight:600; letter-spacing:-.01em; }
  .summary  { font-size:12.5px; color:#98a2b3; margin-top:3px; line-height:1.45; }

  /* The closer look, running behind an already-usable banner. */
  .deeper {
    display:flex; align-items:center; gap:7px;
    font-size:11.5px; color:#6d7787; margin-top:6px;
  }
  .spin {
    width:10px; height:10px; border-radius:50%; flex:none;
    border:1.5px solid #2b323d; border-top-color:#8d97a6;
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }
  .deeper.done .spin { display:none; }
  .deeper.done { color:#3ad57f; }

  .actions { display:flex; gap:8px; padding:0 16px 14px; flex-wrap:wrap; }
  button {
    font: inherit; font-size:12.5px; font-weight:500;
    border-radius:999px; padding:7px 14px; cursor:pointer;
    border:1px solid #2b323d; background:#1e232c; color:#eef1f6;
    transition: background .12s ease, border-color .12s ease;
  }
  button:hover { background:#252b35; }
  button.primary { background:#3ad57f; border-color:#3ad57f; color:#08130c; font-weight:600; }
  button.primary:hover { background:#4ae08c; }
  button.quiet { background:transparent; border-color:transparent; color:#98a2b3; }
  button.quiet:hover { color:#eef1f6; }
  button:focus-visible { outline:2px solid #3ad57f; outline-offset:2px; }
  .spacer { flex:1 1 auto; }

  .list { border-top:1px solid #232933; padding:10px 16px 14px; display:none; }
  .list.open { display:block; }
  .row { display:flex; gap:8px; align-items:baseline; padding:5px 0; font-size:12.5px; }
  .val {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size:11.5px;
    background:#2a1f1f; color:#f2a08c; border-radius:4px; padding:1px 6px;
    max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .arrow { color:#6d7787; }
  .rep {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size:11.5px;
    background:#12281d; color:#3ad57f; border-radius:4px; padding:1px 6px;
  }
  .why { color:#8d97a6; font-size:11.5px; }
  .tag { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:#e8c455; }
  .foot { font-size:11px; color:#6d7787; padding:0 16px 12px; }
`

export type BannerAction =
  | 'redact'
  | 'pseudonymize'
  | 'handoff'
  | 'dismiss'
  | 'send-anyway'

interface BannerOptions {
  response: CheckResponse
  /** Only offered when the user is trying to send, not on paste. */
  allowSendAnyway: boolean
  onAction: (action: BannerAction) => void
}

/** A live banner, with the handles needed to update it in place. */
interface Live {
  host: HTMLDivElement
  wrap: HTMLDivElement
  headline: HTMLDivElement
  summary: HTMLDivElement
  deeper: HTMLDivElement
  list: HTMLDivElement
  foot: HTMLDivElement
  actions: HTMLDivElement
  onAction: (action: BannerAction) => void
  allowSendAnyway: boolean
  /** Set once the closer look has answered, so cleaning reuses its findings. */
  deep: boolean
}

let live: Live | null = null

export function dismissBanner(): void {
  live?.host.remove()
  live = null
}

/** True while a banner is on screen — the content script uses this to update. */
export function bannerIsOpen(): boolean {
  return live !== null
}

function summarise(response: CheckResponse): string {
  if (response.degraded) return `${response.degraded}. Nothing was checked.`
  return `Found ${response.summary}. This stays on your device — cleaning happens here, nothing is uploaded.`
}

export function showBanner({
  response,
  allowSendAnyway,
  onAction,
}: BannerOptions): void {
  dismissBanner()

  const host = document.createElement('div')
  host.setAttribute('data-ai-safe', '')
  const root = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = STYLE
  root.append(style)

  const wrap = document.createElement('div')
  wrap.className = `wrap ${response.decision === 'block' ? 'block' : 'warn'}`

  const top = document.createElement('div')
  top.className = 'top'
  const dot = document.createElement('span')
  dot.className = 'dot'
  const text = document.createElement('div')

  const headline = document.createElement('div')
  headline.className = 'headline'
  headline.textContent =
    response.decision === 'block' ? `⚠ ${response.headline}` : response.headline

  const summary = document.createElement('div')
  summary.className = 'summary'
  summary.textContent = summarise(response)

  // Present from the start but empty, so the closer look landing does not
  // shift the layout under a cursor that is already moving toward a button.
  const deeper = document.createElement('div')
  deeper.className = 'deeper'

  text.append(headline, summary, deeper)
  top.append(dot, text)

  const list = document.createElement('div')
  list.className = 'list'

  const foot = document.createElement('div')
  foot.className = 'foot'
  foot.textContent = `Checked locally in ${response.ms.toFixed(0)} ms`

  const actions = document.createElement('div')
  actions.className = 'actions'

  wrap.append(top, actions, list, foot)
  root.append(wrap)
  document.documentElement.append(host)

  live = {
    host,
    wrap,
    headline,
    summary,
    deeper,
    list,
    foot,
    actions,
    onAction,
    allowSendAnyway,
    deep: false,
  }

  renderFindings(response.findings)
  renderActions(response)

  // Escape always gets you out. A safety tool you cannot dismiss is a safety
  // tool people uninstall.
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') onAction('dismiss')
  })
}

/** Says the closer look is running, without making anyone wait for it. */
export function showDeeperRunning(): void {
  if (!live) return
  live.deeper.className = 'deeper'
  live.deeper.replaceChildren()

  const spin = document.createElement('span')
  spin.className = 'spin'
  const label = document.createElement('span')
  label.textContent = 'Taking a closer look…'

  live.deeper.append(spin, label)
}

/**
 * Fold the closer look into the banner already on screen.
 *
 * Deliberately an update rather than a replacement: the user may already be
 * reading it, and pulling the panel out from under them to put a nearly
 * identical one back is worse than the small inconsistency of updating in
 * place.
 */
export function applyDeeper(result: DeepCheckResponse): void {
  if (!live) return

  live.deep = true

  if (result.unavailable) {
    live.deeper.className = 'deeper'
    live.deeper.replaceChildren()
    live.deeper.textContent = `Closer look unavailable — showing the quick check only.`
    return
  }

  live.wrap.className = `wrap ${result.decision === 'block' ? 'block' : 'warn'}`
  live.headline.textContent =
    result.decision === 'block' ? `⚠ ${result.headline}` : result.headline
  live.summary.textContent = summarise({ ...result, type: 'checked' })
  live.foot.textContent = `Checked locally in ${result.ms.toFixed(0)} ms`

  live.deeper.className = 'deeper done'
  live.deeper.replaceChildren()
  live.deeper.textContent = changeNote(result)

  renderFindings(result.findings)
  renderActions({ ...result, type: 'checked' })
}

/** What the second opinion actually changed, in the user's terms. */
function changeNote(result: DeepCheckResponse): string {
  const parts: string[] = []
  if (result.withdrawn) {
    parts.push(
      `ruled out ${result.withdrawn} false alarm${result.withdrawn === 1 ? '' : 's'}`,
    )
  }
  if (result.added) {
    parts.push(`caught ${result.added} more`)
  }
  return parts.length
    ? `✓ Closer look ${parts.join(' and ')}`
    : '✓ Closer look agreed with the quick check'
}

function renderActions(response: CheckResponse): void {
  if (!live) return
  const { onAction, allowSendAnyway } = live

  live.actions.replaceChildren()

  // The primary action always moves forward. Even on a block, the offer is
  // "clean it and carry on", never a dead end.
  live.actions.append(
    button('Mask it', 'primary', () => onAction('redact')),
    button('Use fake names', '', () => onAction('pseudonymize')),
  )

  const details = button('View details', '', () => {
    live?.list.classList.toggle('open')
    details.textContent = live?.list.classList.contains('open')
      ? 'Hide details'
      : 'View details'
  })
  live.actions.append(details, button('Edit in AI Safe', '', () => onAction('handoff')))

  const spacer = document.createElement('span')
  spacer.className = 'spacer'
  live.actions.append(spacer)

  if (allowSendAnyway && response.decision !== 'block') {
    live.actions.append(
      button('Send anyway', 'quiet', () => onAction('send-anyway')),
    )
  }
  live.actions.append(button('Cancel', 'quiet', () => onAction('dismiss')))
}

function renderFindings(findings: WireFinding[]): void {
  if (!live) return
  const open = live.list.classList.contains('open')
  live.list.replaceChildren()

  for (const finding of findings.slice(0, 12)) live.list.append(row(finding))

  if (findings.length > 12) {
    const more = document.createElement('div')
    more.className = 'why'
    more.textContent = `…and ${findings.length - 12} more`
    live.list.append(more)
  }
  if (open) live.list.classList.add('open')
}

/** Confirmation after cleaning — the user must know their text changed. */
export function showCleaned(count: number, onDone: () => void): void {
  dismissBanner()

  const host = document.createElement('div')
  host.setAttribute('data-ai-safe', '')
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = STYLE
  root.append(style)

  const wrap = document.createElement('div')
  wrap.className = 'wrap ok'
  const top = document.createElement('div')
  top.className = 'top'
  const dot = document.createElement('span')
  dot.className = 'dot'
  const text = document.createElement('div')
  const headline = document.createElement('div')
  headline.className = 'headline'
  headline.textContent = '✓ Prompt cleaned'
  const summary = document.createElement('div')
  summary.className = 'summary'
  summary.textContent = `${count} item${count === 1 ? '' : 's'} replaced in your prompt. Check it reads correctly, then send as usual.`
  text.append(headline, summary)
  top.append(dot, text)

  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(button('Got it', 'primary', onDone))

  wrap.append(top, actions)
  root.append(wrap)
  document.documentElement.append(host)

  live = {
    host,
    wrap,
    headline,
    summary,
    deeper: document.createElement('div'),
    list: document.createElement('div'),
    foot: document.createElement('div'),
    actions,
    onAction: () => onDone(),
    allowSendAnyway: false,
    deep: true,
  }

  // Auto-dismiss only this banner. Comparing identity matters: by the time the
  // timer fires the user may have pasted again and be looking at a live
  // warning, and closing that one for them would be a bug with consequences.
  const mine = live
  window.setTimeout(() => {
    if (live === mine) onDone()
  }, 6000)
}

/** Whether the banner on screen has the closer look's findings behind it. */
export function bannerIsDeep(): boolean {
  return live?.deep ?? false
}

function button(
  label: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = label
  element.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onClick()
  })
  return element
}

function row(finding: WireFinding): HTMLDivElement {
  const element = document.createElement('div')
  element.className = 'row'

  const value = document.createElement('span')
  value.className = 'val'
  value.textContent =
    finding.value.length > 40 ? `${finding.value.slice(0, 37)}…` : finding.value

  const arrow = document.createElement('span')
  arrow.className = 'arrow'
  arrow.textContent = '→'

  const replacement = document.createElement('span')
  replacement.className = 'rep'
  replacement.textContent = finding.replacement

  const why = document.createElement('span')
  why.className = 'why'
  why.textContent = finding.label

  element.append(value, arrow, replacement, why)

  if (finding.tier !== 'high') {
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = 'possible'
    element.append(tag)
  }

  return element
}
