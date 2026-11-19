import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// The compiler options live in svelte.config.js; the element bundle injects its CSS into each
// shadow root instead of emitting a stylesheet.
export default defineConfig({
  test: { environment: 'happy-dom' },
  resolve: {
    conditions: process.env.VITEST === 'true' ? ['browser'] : undefined,
  },
  plugins: [svelte({ emitCss: false, dynamicCompileOptions: () => ({ css: 'injected' }) })],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/elements/index.ts'),
      formats: ['es'],
      fileName: () => 'elements/index.js',
    },
  },
})
