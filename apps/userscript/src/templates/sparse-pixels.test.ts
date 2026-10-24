import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  cutPixels,
  joinPixels,
  PIXEL_CHUNK_SIZE,
  packPixels,
  pixelAt,
  pixelRect,
  storedArea,
  unpackPixels,
} from './sparse-pixels.js'

/** 2500 × 1200: a 3 × 2 chunk grid with ragged right and bottom chunks. */
const WIDTH = 2500
const HEIGHT = 1200

const image = (paint: readonly (readonly [number, number, number])[]): Uint8Array => {
  const dense = new Uint8Array(WIDTH * HEIGHT).fill(TRANSPARENT_INDEX)
  for (const [x, y, index] of paint) dense[y * WIDTH + x] = index
  return dense
}

/** Byte equality for megapixel arrays, which a deep equality matcher walks too slowly. */
const same = (left: Uint8Array, right: Uint8Array): boolean =>
  Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
    Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  )

describe('sparse pixels', () => {
  it('keeps only painted chunks and round trips the image', () => {
    const dense = image([
      [0, 0, 5],
      [2499, 1199, 7],
      [999, 1000, 9],
    ])
    const pixels = cutPixels(WIDTH, HEIGHT, dense)
    // Top-left full chunk, bottom-left 1000 × 200 chunk, bottom-right 500 × 200 chunk.
    expect(storedArea(pixels)).toBe(PIXEL_CHUNK_SIZE ** 2 + 1000 * 200 + 500 * 200)
    expect(same(joinPixels(pixels), dense)).toBe(true)
    expect(pixelAt(pixels, 2499, 1199)).toBe(7)
    expect(pixelAt(pixels, 1500, 500)).toBe(TRANSPARENT_INDEX)
  })

  it('reads rectangles across chunk edges and outside the template', () => {
    const pixels = cutPixels(
      WIDTH,
      HEIGHT,
      image([
        [999, 999, 1],
        [1000, 1000, 2],
      ]),
    )
    expect([...pixelRect(pixels, 998, 998, 4, 4)]).toEqual([
      ...[TRANSPARENT_INDEX, TRANSPARENT_INDEX, TRANSPARENT_INDEX, TRANSPARENT_INDEX],
      ...[TRANSPARENT_INDEX, 1, TRANSPARENT_INDEX, TRANSPARENT_INDEX],
      ...[TRANSPARENT_INDEX, TRANSPARENT_INDEX, 2, TRANSPARENT_INDEX],
      ...[TRANSPARENT_INDEX, TRANSPARENT_INDEX, TRANSPARENT_INDEX, TRANSPARENT_INDEX],
    ])
    expect([...pixelRect(pixels, -1, -1, 2, 1)]).toEqual([TRANSPARENT_INDEX, TRANSPARENT_INDEX])
  })

  it('unpacks what it packed, and refuses bytes that do not fit the layout', () => {
    const pixels = cutPixels(WIDTH, HEIGHT, image([[2000, 100, 3]]))
    const packed = packPixels(pixels)
    const unpacked = unpackPixels(WIDTH, HEIGHT, packed)
    if (unpacked === null) throw new Error('packed pixels did not unpack')
    expect(same(joinPixels(unpacked), joinPixels(pixels))).toBe(true)
    expect(unpackPixels(WIDTH, HEIGHT, { ...packed, bytes: packed.bytes.subarray(1) })).toBeNull()
    expect(unpackPixels(WIDTH, HEIGHT, { ...packed, chunks: [6] })).toBeNull()
  })
})
