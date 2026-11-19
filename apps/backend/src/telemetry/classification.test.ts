import {
  BLANK,
  encodeMismatchMask,
  MATCH,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WRONG,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { type ChunkRect, classifyChunk } from './classify-chunk.js'

/** The Map-based loop this kernel replaced. Kept here so equivalence stays testable. */
const referenceClassify = (chunk: Uint8Array, canvas: Uint8Array, rect: ChunkRect) => {
  let correct = 0
  let wrong = 0
  let blank = 0
  const classifications = new Uint8Array(rect.width * rect.height)
  const colours = new Map<
    number,
    { index: number; correct: number; wrong: number; blank: number; total: number }
  >()
  for (let y = 0; y < rect.height; y += 1) {
    const chunkRow = y * rect.width
    const canvasRow = (rect.top + y) * TILE_SIZE + rect.left
    for (let x = 0; x < rect.width; x += 1) {
      const wanted = chunk[chunkRow + x] ?? TRANSPARENT_INDEX
      if (wanted === TRANSPARENT_INDEX) continue
      const actual = canvas[canvasRow + x] ?? TRANSPARENT_INDEX
      const colour = colours.get(wanted) ?? {
        index: wanted,
        correct: 0,
        wrong: 0,
        blank: 0,
        total: 0,
      }
      colour.total++
      if (actual === TRANSPARENT_INDEX) {
        blank++
        colour.blank++
        classifications[chunkRow + x] = BLANK
      } else if (actual === wanted) {
        correct++
        colour.correct++
        classifications[chunkRow + x] = MATCH
      } else {
        wrong++
        colour.wrong++
        classifications[chunkRow + x] = WRONG
      }
      colours.set(wanted, colour)
    }
  }
  return {
    correct,
    wrong,
    blank,
    colours: [...colours.values()].sort((left, right) => left.index - right.index),
    classifications,
  }
}

const seeded = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const randomChunk = (random: () => number, pixels: number, transparentShare: number) =>
  Uint8Array.from({ length: pixels }, () =>
    random() < transparentShare ? TRANSPARENT_INDEX : Math.floor(random() * 63),
  )

const randomCanvas = (random: () => number, chunk: Uint8Array, rect: ChunkRect) => {
  const canvas = new Uint8Array(TILE_SIZE * TILE_SIZE)
  for (let index = 0; index < canvas.length; index += 1) {
    canvas[index] = random() < 0.2 ? TRANSPARENT_INDEX : Math.floor(random() * 63)
  }
  // Make most template pixels match so every class is well represented.
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      if (random() < 0.6) {
        canvas[(rect.top + y) * TILE_SIZE + rect.left + x] =
          chunk[y * rect.width + x] ?? TRANSPARENT_INDEX
      }
    }
  }
  return canvas
}

describe('classifyChunk', () => {
  it('matches the reference loop exactly on random partial chunks', () => {
    const random = seeded(397)
    for (let round = 0; round < 25; round += 1) {
      const width = 1 + Math.floor(random() * 300)
      const height = 1 + Math.floor(random() * 300)
      const rect = {
        left: Math.floor(random() * (TILE_SIZE - width + 1)),
        top: Math.floor(random() * (TILE_SIZE - height + 1)),
        width,
        height,
      }
      const chunk = randomChunk(random, width * height, random())
      const canvas = randomCanvas(random, chunk, rect)
      const expected = referenceClassify(chunk, canvas, rect)
      const actual = classifyChunk(chunk, canvas, rect)

      expect(actual.correct).toBe(expected.correct)
      expect(actual.wrong).toBe(expected.wrong)
      expect(actual.blank).toBe(expected.blank)
      expect(actual.colours).toEqual(expected.colours)
      expect(Buffer.from(actual.classifications).equals(expected.classifications)).toBe(true)
      expect(encodeMismatchMask(rect, actual.classifications)).toEqual(
        encodeMismatchMask(rect, expected.classifications),
      )
    }
  })

  it('reports an empty colour list for a fully transparent chunk', () => {
    const rect = { left: 10, top: 20, width: 4, height: 3 }
    const chunk = new Uint8Array(12).fill(TRANSPARENT_INDEX)
    const result = classifyChunk(chunk, new Uint8Array(TILE_SIZE * TILE_SIZE), rect)

    expect(result).toEqual({
      correct: 0,
      wrong: 0,
      blank: 0,
      colours: [],
      classifications: new Uint8Array(12),
    })
  })

  it.runIf(process.env.CAELESTIS_PERFORMANCE === '1')(
    'keeps a full canvas tile well under the live command budget',
    () => {
      const random = seeded(1_000_000)
      const rect = { left: 0, top: 0, width: TILE_SIZE, height: TILE_SIZE }
      const chunk = randomChunk(random, TILE_SIZE * TILE_SIZE, 0.3)
      const canvas = randomCanvas(random, chunk, rect)
      const measure = (classify: typeof classifyChunk) => {
        const startedAt = performance.now()
        encodeMismatchMask(rect, classify(chunk, canvas, rect).classifications)
        return performance.now() - startedAt
      }
      // Warm the encoder as well as both classifiers. A cold encode used to count only against
      // the optimized path, making the comparison depend on Bun's JIT compilation timing.
      for (let round = 0; round < 5; round++) {
        measure(classifyChunk)
        measure(referenceClassify)
      }
      const optimized = []
      const reference = []
      for (let round = 0; round < 7; round++) {
        // Alternate order so scheduling pauses do not consistently penalize the same path.
        if (round % 2 === 0) {
          optimized.push(measure(classifyChunk))
          reference.push(measure(referenceClassify))
        } else {
          reference.push(measure(referenceClassify))
          optimized.push(measure(classifyChunk))
        }
      }
      const median = (samples: number[]) =>
        samples.sort((left, right) => left - right)[Math.floor(samples.length / 2)] ?? 0
      const elapsedMs = median(optimized)
      const referenceMs = median(reference)
      const result = classifyChunk(chunk, canvas, rect)
      const mask = encodeMismatchMask(rect, result.classifications)
      console.info(
        `full-tile classify + encode median ${elapsedMs.toFixed(1)} ms (reference ${referenceMs.toFixed(1)} ms), ${mask.byteLength} bytes`,
      )

      expect(result.correct + result.wrong + result.blank).toBeGreaterThan(600_000)
      // Compare the same end-to-end work, retaining the 2x improvement requirement. A median
      // rejects isolated GC/scheduling pauses while still catching a return to per-pixel allocation.
      expect(elapsedMs).toBeLessThan(referenceMs / 2)
    },
  )
})
