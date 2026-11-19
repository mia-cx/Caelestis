import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const module = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    // The build plugin's virtual modules. Tests read the package's own binary and run Ditherette
    // in-process on the CPU, as a page without workers or WebGPU would; nothing compiles the GPU
    // binary there, so an empty one stands in.
    alias: {
      'ditherette:scalar-wasm': module('./test/ditherette-wasm.ts'),
      'ditherette:gpu-wasm': module('./test/ditherette-no-gpu.ts'),
      'ditherette:worker': module('./test/ditherette-no-worker.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    // Run the built backend natively: Node 22's experimental node:sqlite is absent from
    // builtinModules, so Vitest otherwise tries to bundle it for the DOM environment.
    server: { deps: { external: [/\/backend\/dist\//] } },
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
  },
})
