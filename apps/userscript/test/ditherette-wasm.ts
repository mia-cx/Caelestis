import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The binary the build inlines as `ditherette:scalar-wasm`. */
const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL('./wasm/scalar/ditherette_wasm_bg.wasm', import.meta.resolve('ditherette')),
    ),
  ),
)
export default bytes
