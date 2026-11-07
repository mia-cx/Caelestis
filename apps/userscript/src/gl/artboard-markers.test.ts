import { TRANSPARENT_INDEX as T } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { NO_NATIVE_DRAFT } from '../native-pixels.js'
import { cutPixels } from '../templates/sparse-pixels.js'
import { artboardColourProgress } from './artboard-markers.js'

const colour = (index: number, counts: Record<string, number>) => ({
  index,
  completed: 0,
  mismatched: 0,
  unpainted: 0,
  known: 0,
  total: 0,
  ...counts,
})

it('reuses alliance progress until the native pixels or the template placement change', () => {
  const pixels = cutPixels(6, 1, new Uint8Array([1, 2, 2, 2, T, 1]))
  const committed = new Uint8Array([1, T, 5, 2, 0])
  const native = {
    committed: [{ x: 10, y: 0, width: 5, height: 1, pixels: committed, emptyIndex: T }],
    // A drafted 2 over unpainted art, then an explicit transparent draft over a painted 2.
    draft: [
      {
        x: 11,
        y: 0,
        width: 3,
        height: 1,
        pixels: new Uint8Array([2, NO_NATIVE_DRAFT, NO_NATIVE_DRAFT]),
        present: new Uint8Array([0, 0, 1]),
        emptyIndex: NO_NATIVE_DRAFT,
      },
    ],
    revision: 1,
  }
  const template = { originX: 10, originY: 0, width: 6, height: 1, pixels }

  expect(artboardColourProgress(template, native)).toEqual([
    colour(1, { completed: 1, known: 1, total: 2 }),
    colour(2, { completed: 1, mismatched: 1, unpainted: 1, known: 3, total: 3 }),
  ])

  // Wplace patches its retained pixels in place, then the read reports a new revision.
  committed[2] = 2
  const repainted = artboardColourProgress(template, { ...native, revision: 2 })
  expect(repainted).toEqual([
    colour(1, { completed: 1, known: 1, total: 2 }),
    colour(2, { completed: 2, unpainted: 1, known: 3, total: 3 }),
  ])
  expect(artboardColourProgress(template, { ...native, revision: 2 })).toBe(repainted)

  expect(artboardColourProgress({ ...template, originX: 11 }, { ...native, revision: 2 })).toEqual([
    colour(1, { mismatched: 1, known: 1, total: 2 }),
    colour(2, { completed: 1, mismatched: 1, unpainted: 1, known: 3, total: 3 }),
  ])
})
