import { PALETTE_RGB, TRANSPARENT_INDEX } from '@caelestis/shared'
import type { Samples } from '@caelestis/ui/elements'
import type { Rgba8Image } from 'ditherette'

/**
 * Pixels for the template studio's scopes, sampled as Ditherette web samples them. Sampling is
 * seeded, so the source, its effects, and the output of one image sample the same positions and
 * compare like for like.
 */

/** A quarter of a million samples fills every scope smoothly and keeps redraws quick. */
const MAX_SAMPLES = 1 << 18
/** Enough sample columns to resolve the waveform at any window width. */
const MAX_COLUMNS = 1024

/** Mulberry32: a small seeded generator, so the same image always samples the same pixels. */
const random = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * One pixel from a random spot in each cell of an even grid. Small images keep every pixel; on
 * large ones the jitter stops a regular dither pattern from lining up with the grid.
 * `pick` copies pixel `index` into `rgb` at `at`, or returns false for a transparent pixel.
 */
const samplePixels = (
  width: number,
  height: number,
  pick: (index: number, rgb: Uint8Array, at: number) => boolean,
): Samples => {
  // An image within the budget keeps every pixel, however wide it is.
  const whole = width * height <= MAX_SAMPLES
  const columns = whole ? width : Math.min(width, MAX_COLUMNS)
  const rows = whole ? height : Math.min(height, Math.max(1, Math.floor(MAX_SAMPLES / columns)))
  const column = new Float32Array(columns * rows)
  const rgb = new Uint8Array(columns * rows * 3)
  const next = random(1)
  let count = 0
  for (let row = 0; row < rows; row++) {
    for (let cell = 0; cell < columns; cell++) {
      const x = Math.floor(((cell + next()) * width) / columns)
      const y = Math.floor(((row + next()) * height) / rows)
      if (!pick(y * width + x, rgb, count * 3)) continue
      column[count++] = (x + 0.5) / width
    }
  }
  return { count, column, rgb }
}

/** Visible pixels of an RGBA image; fully transparent ones are skipped. */
export const sampleRgba = ({ width, height, data }: Rgba8Image): Samples =>
  samplePixels(width, height, (index, rgb, at) => {
    const offset = index * 4
    if (!data[offset + 3]) return false
    rgb.set(data.subarray(offset, offset + 3), at)
    return true
  })

/** Palette pixels of processed artwork, in the exact Wplace colours it will paint. */
export const sampleArtwork = (width: number, height: number, indices: Uint8Array): Samples =>
  samplePixels(width, height, (index, rgb, at) => {
    const colour = indices[index]
    const value =
      colour === undefined || colour === TRANSPARENT_INDEX ? undefined : PALETTE_RGB[colour]
    if (value === undefined) return false
    rgb.set(value, at)
    return true
  })
