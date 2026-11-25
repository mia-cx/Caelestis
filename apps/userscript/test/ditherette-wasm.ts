import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * `ditherette:wasm` for tests: the package's own scalar binary, as the build inlines it. Tests have
 * no WebGPU, so nothing asks for the GPU binary.
 */
export default async (variant: 'scalar' | 'gpu'): Promise<Uint8Array<ArrayBuffer>> => {
  if (variant === 'gpu') throw new Error('tests run Ditherette on the CPU')
  return new Uint8Array(
    readFileSync(
      fileURLToPath(
        new URL('./wasm/scalar/ditherette_wasm_bg.wasm', import.meta.resolve('ditherette')),
      ),
    ),
  )
}
