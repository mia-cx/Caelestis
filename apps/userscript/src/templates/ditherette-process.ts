import { type DitheretteTemplateRecipe, PALETTE_RGB, TRANSPARENT_INDEX } from '@caelestis/shared'
import type { Ditherette, PaletteEntry, Progress, Rgba8Image } from 'ditherette'

/**
 * One Ditherette recipe run: crop, then Ditherette's resize, matching, and dither.
 *
 * The worker and the in-process fallback both call this, so a template rebuilt from its recipe on
 * either path is the artwork the editor showed.
 */

/** Processed artwork in Wplace's palette indices. */
export interface DitheretteArtwork {
  readonly indices: Uint8Array
  readonly opaque: number
}

/** The crop's pixels as packed RGBA8. A crop covering the whole source returns the source itself. */
export const cropRgba = (
  source: Rgba8Image,
  crop: DitheretteTemplateRecipe['crop'],
): Rgba8Image => {
  if (crop.x === 0 && crop.y === 0 && crop.width === source.width && crop.height === source.height)
    return source
  const data = new Uint8Array(crop.width * crop.height * 4)
  const row = crop.width * 4
  for (let y = 0; y < crop.height; y++) {
    const start = ((crop.y + y) * source.width + crop.x) * 4
    data.set(source.data.subarray(start, start + row), y * row)
  }
  return { width: crop.width, height: crop.height, data }
}

/** The recipe's colours in its order, then transparency, so thresholded alpha has a slot. */
const paletteEntries = (palette: readonly number[]): PaletteEntry[] => [
  ...palette.map((index): PaletteEntry => {
    const rgb = PALETTE_RGB[index]
    if (rgb === undefined) throw new RangeError(`palette index ${index} is not a Wplace colour`)
    return { kind: 'color', rgb }
  }),
  { kind: 'transparent' },
]

/** Run a recipe on its decoded source. Throws Ditherette's own errors for refused settings. */
export const processDitherette = (
  processor: Ditherette,
  source: Rgba8Image,
  recipe: DitheretteTemplateRecipe,
  onProgress?: (progress: Progress) => void,
): DitheretteArtwork => {
  if (source.width !== recipe.source.width || source.height !== recipe.source.height)
    throw new Error('the decoded source is not the size its recipe names')
  const result = processor.process({
    source: cropRgba(source, recipe.crop),
    palette: paletteEntries(recipe.palette),
    recipe: recipe.ditherette,
    ...(onProgress === undefined ? {} : { onProgress }),
  })
  if (result.width !== recipe.width || result.height !== recipe.height)
    throw new Error('Ditherette returned unexpected template dimensions')
  // Ditherette indexes the entries above; the last one is transparency.
  const indices = new Uint8Array(result.indices.length)
  let opaque = 0
  for (let pixel = 0; pixel < indices.length; pixel++) {
    const index = recipe.palette[result.indices[pixel] ?? recipe.palette.length]
    if (index === undefined) {
      indices[pixel] = TRANSPARENT_INDEX
      continue
    }
    indices[pixel] = index
    opaque++
  }
  return { indices, opaque }
}
