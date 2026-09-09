import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerLocalModel } from '@/engine/confirm'
import { createGlinerConfirmer } from '@/engine/confirm/gliner'
import { registerMetricsSink } from '@/engine/metrics'
import { LocalSource } from '@/metrics/localSource'

// Registering costs nothing: the weights are only fetched if a scan actually
// escalates, and they are served from this app's own origin after
// `npm run provision:model`. If they were never provisioned the engine falls
// back to the deterministic confirmer, so the app works either way.
registerLocalModel(createGlinerConfirmer())

// Performance metrics, on this device only. The engine holds a one-method
// write seam and knows nothing about storage, which is what keeps it runnable
// in Node; this is where an implementation gets attached. No transport exists:
// the store has no fetch, no endpoint and no export path but the one the user
// asks for.
export const metricsSource = new LocalSource()
registerMetricsSink(metricsSource)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
