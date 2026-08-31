import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  test: {
    // The engine is pure and needs no DOM; only the extension's adapters do,
    // so the environment is opt-in per file via a docblock rather than paid
    // for by every test.
    environment: 'node',
    environmentMatchGlobs: [['extension/**', 'happy-dom']],
  },
})
