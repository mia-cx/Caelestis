import { PALETTE_RGB } from '@caelestis/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import { analyseFit, runDitherette, sampleEffects } from '../src/templates/ditherette.js'

// A worker bundle exists, but the page refuses to start it, as a strict CSP would.
vi.mock('ditherette:worker', () => ({ default: 'self.close()' }))

// A Ditherette GPU instance refuses a second call while one runs, so count the calls that overlap.
const calls = vi.hoisted(() => ({ active: 0, most: 0 }))
vi.mock('../src/templates/ditherette-process.js', async (original) => {
  const actual = await original<typeof import('../src/templates/ditherette-process.js')>()
  const tracked =
    <Args extends unknown[], Result>(call: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      calls.most = Math.max(calls.most, ++calls.active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return await call(...args)
      } finally {
        calls.active--
      }
    }
  return {
    ...actual,
    processDitherette: tracked(actual.processDitherette),
    applyRecipeEffects: tracked(actual.applyRecipeEffects),
  }
})

const SIZE = 2
const image = { width: SIZE, height: SIZE, data: new Uint8Array(SIZE * SIZE * 4).fill(200) }
const source = { key: 'flat', image }
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

beforeEach(() => {
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new DOMException('Blob workers are not allowed.', 'SecurityError')
      }
    },
  )
  calls.most = 0
})

it('analyses a palette fit in the page when the worker cannot start', async () => {
  const analysis = analyseFit({
    source,
    analysis: { recipe, before: [], look: 'fitted', space: 'oklab' },
  })
  await expect(analysis).resolves.toEqual(expect.any(Array))
})

it('runs one Ditherette call at a time in the page, past a cancelled job and alongside scopes', async () => {
  const controller = new AbortController()
  const cancelled = runDitherette({ recipe, source, signal: controller.signal })
  await vi.waitFor(() => expect(calls.active).toBe(1), { timeout: 5_000, interval: 1 })
  controller.abort()
  await expect(cancelled).rejects.toThrow()

  await Promise.all([runDitherette({ recipe, source }), sampleEffects({ recipe, source })])
  expect(calls.most).toBe(1)
})
