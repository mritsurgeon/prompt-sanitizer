import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerLocalModel } from '@/engine/confirm'
import { createGlinerConfirmer } from '@/engine/confirm/gliner'

// Registering costs nothing: the weights are only fetched if a scan actually
// escalates, and they are served from this app's own origin after
// `npm run provision:model`. If they were never provisioned the engine falls
// back to the deterministic confirmer, so the app works either way.
registerLocalModel(createGlinerConfirmer())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
