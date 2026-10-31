import { PALETTE_RGB } from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import { analyseFit } from '../src/templates/ditherette.js'

// A worker bundle exists, but the page refuses to start it, as a strict CSP would.
vi.mock('ditherette:worker', () => ({ default: 'self.close()' }))

const SIZE = 2
const image = { width: SIZE, height: SIZE, data: new Uint8Array(SIZE * SIZE * 4).fill(200) }
const recipe = {
  format: 1,
  processor: 'ditherette',
  processorVersion: 1,
  source: { sha256: 'a'.repeat(64), width: SIZE, height: SIZE },
  crop: { x: 0, y: 0, width: SIZE, height: SIZE },
  width: SIZE,
  height: SIZE,
  palette: PALETTE_RGB.map((_, index) => index),
  engine: 'cpu',
  ditherette: {
    version: 2,
    effects: [],
    output: { width: SIZE, height: SIZE, resize: { algorithm: 'nearest', anchor: 'top-left' } },
    alpha: { mode: 'preserve', threshold: 128 },
    match: 'oklab-euclidean',
    dither: { family: 'none' },
  },
} as const

it('analyses a palette fit in the page when the worker cannot start', async () => {
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new DOMException('Blob workers are not allowed.', 'SecurityError')
      }
    },
  )
  const analysis = analyseFit({
    source: { key: 'flat', image },
    analysis: { recipe, before: [], look: 'fitted', space: 'oklab' },
  })
  await expect(analysis).resolves.toEqual(expect.any(Array))
})
