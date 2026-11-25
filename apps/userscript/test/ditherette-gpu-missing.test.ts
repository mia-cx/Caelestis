import { expect, it, vi } from 'vitest'
import { ditheretteAvailable } from '../src/templates/ditherette.js'

// `ditherette:wasm` in tests rejects the GPU binary, as a release userscript whose GPU resource
// failed to load would.
it('still processes images on the CPU when the GPU binary does not load', async () => {
  vi.stubGlobal('navigator', { ...navigator, gpu: {} })
  expect(await ditheretteAvailable()).toBe(true)
})
