import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
/**
 * Cross-origin isolation, so the ONNX runtime can use `SharedArrayBuffer`.
 *
 * The threaded WASM build needs it, and without it the load does not fall
 * back politely — it hangs, so the confirmer never resolves and the scan
 * waits out its budget. The engine now checks `crossOriginIsolated` and runs
 * single-threaded where these are absent, so this is the difference between
 * a fast model and a slow one rather than between one and none.
 *
 * `Cross-Origin-Resource-Policy` is here for a different consumer: the
 * extension fetches the model weights from this origin, which is cross-origin
 * from its own, and its offscreen document declares COEP. Without CORP on
 * these responses that fetch is blocked.
 */
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: { headers: ISOLATION },
  // `server` covers `npm run dev` only. Preview serves the built app, and a
  // production host has to be configured to send the same three headers or
  // the deployed app quietly runs single-threaded.
  preview: { headers: ISOLATION },
})
