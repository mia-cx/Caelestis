import { expect, it, vi } from 'vitest'
import loadResource from '../src/templates/ditherette-resources.js'

// SHA-256 of the bytes "abc", base64 (FIPS 180-2 test vector).
const ABC_SHA256 = 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='

it('refuses a resource whose bytes differ from its pinned hash', async () => {
  const served = { 'ditherette-scalar': 'data:application/wasm;base64,YWJj' }
  vi.stubGlobal('GM_getResourceURL', (name: keyof typeof served) => served[name])

  const bytes = await loadResource('ditherette-scalar', ABC_SHA256)
  expect(new TextDecoder().decode(bytes)).toBe('abc')

  served['ditherette-scalar'] = 'data:application/wasm;base64,YWJk'
  await expect(loadResource('ditherette-scalar', ABC_SHA256)).rejects.toThrow('pinned hash')
})
