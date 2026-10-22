import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const module = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    // The build plugin's virtual modules. Tests read the package's own binary and run Ditherette
    // in-process, as a page without workers would.
    alias: {
      'ditherette:scalar-wasm': module('./test/ditherette-wasm.ts'),
      'ditherette:worker': module('./test/ditherette-no-worker.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
  },
})
