import scalarWasm from 'ditherette:scalar-wasm'
import { PALETTE_RGB } from '@caelestis/shared'
import { ALPHA_MODES, COLOR_SPACES, DITHER_ALGORITHMS, RESIZE_MODES } from '@caelestis/ui/elements'
import { createDitherette, type PaletteEntry } from 'ditherette'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STUDIO_SETTINGS,
  type StudioSettings,
  studioRecipe,
} from '../src/templates/studio-recipe.js'

/** A small gradient with a transparent corner, so every stage has something to do. */
const source = () => {
  const width = 12
  const height = 8
  const data = new Uint8Array(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel++) {
    data.set(
      [(pixel * 37) % 256, (pixel * 11) % 256, (pixel * 5) % 256, pixel < 4 ? 0 : 255],
      pixel * 4,
    )
  }
  return { width, height, data }
}

const palette: PaletteEntry[] = [
  ...[0, 4, 9, 20, 31].map(
    (index): PaletteEntry => ({ kind: 'color', rgb: PALETTE_RGB[index] ?? [0, 0, 0] }),
  ),
  { kind: 'transparent' },
]

const settings = (patch: Partial<StudioSettings> = {}): StudioSettings => ({
  ...DEFAULT_STUDIO_SETTINGS,
  output: { width: 9, height: 6, resize: 'area', anchor: 'center' },
  alpha: { mode: 'preserve', threshold: 128, matte: 4 },
  ...patch,
})

describe('studio recipes', () => {
  // Every choice the studio offers must be a recipe Ditherette accepts; a mistranslated id fails here.
  it('turns every studio choice into a recipe Ditherette runs', async () => {
    const processor = await createDitherette({ wasm: scalarWasm })
    const image = source()
    const run = (patch: Partial<StudioSettings>) =>
      processor.process({ source: image, palette, recipe: studioRecipe(settings(patch)) })
    const base = settings()
    for (const { id } of DITHER_ALGORITHMS)
      for (const useColorSpace of [false, true])
        expect(
          run({ dither: { ...base.dither, algorithm: id, useColorSpace, placement: 'adaptive' } })
            .width,
        ).toBe(9)
    for (const { id } of COLOR_SPACES) expect(run({ colorSpace: id }).height).toBe(6)
    for (const { id } of RESIZE_MODES)
      expect(run({ output: { ...base.output, resize: id, anchor: 'top-left' } }).width).toBe(9)
    for (const { id } of ALPHA_MODES)
      expect(run({ alpha: { ...base.alpha, mode: id } }).width).toBe(9)
    processor.dispose()
  })
})
