import { runtime } from '../browser'
import type { ConfigResponse, StatusResponse } from '../protocol'
import { renderHydration } from './hydrationView'

/**
 * Status only. The popup cannot be opened programmatically, so it is never the
 * surface that warns anybody — it answers "is this working" and "what has it
 * been doing", and both are counts.
 */

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

/**
 * The hydration panel, rendered independently of the status call.
 *
 * Its own await chain on purpose: a worker that has died still leaves the
 * stand-ins readable in `storage.session`, and somebody who needs their names
 * back should get them even while the status line says the checker is
 * unavailable.
 */
const panel = document.getElementById('hydration')
if (panel) void renderHydration(panel)

/**
 * Managed badge.
 *
 * Worth saying plainly rather than leaving somebody to wonder why a setting
 * will not stick: if an organisation is pushing the configuration, the user
 * should be told, and told whether it is enforcing or only watching.
 */
runtime.runtime.sendMessage({ type: 'config' }, (config: ConfigResponse) => {
  if (runtime.runtime.lastError || !config?.managed) return
  const note = document.getElementById('managed')
  if (!note) return
  note.textContent = config.observeOnly
    ? 'Managed by your organisation · audit mode, nothing is blocked'
    : 'Managed by your organisation'
  note.hidden = false
})

runtime.runtime.sendMessage({ type: 'status' }, (status: StatusResponse) => {
  const state = document.getElementById('state')
  const metrics = document.getElementById('metrics')
  if (!state || !metrics) return

  if (runtime.runtime.lastError || !status?.ready) {
    state.textContent = 'Protection unavailable'
    state.className = 'state bad'
    return
  }

  state.textContent = 'Protected locally'
  state.className = 'state good'

  const m = status.metrics
  const rows: [string, string][] = [
    ['Prompts checked', String(m.checked)],
    ['Passed straight through', String(m.allowed)],
    ['Flagged for review', String(m.warned + m.blocked)],
    ['Cleaned', String(m.sanitized)],
    ['Typical check', `${percentile(m.latencies, 50).toFixed(1)} ms`],
    ['Slowest 1 in 20', `${percentile(m.latencies, 95).toFixed(1)} ms`],
  ]

  for (const [label, value] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    metrics.append(dt, dd)
  }
})
