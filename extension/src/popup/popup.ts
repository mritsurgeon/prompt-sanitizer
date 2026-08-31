import { runtime } from '../browser'
import type { StatusResponse } from '../protocol'

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
