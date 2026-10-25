import { type DitheretteTemplateRecipe, PALETTE_RGB, TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { processRecipe } from '../src/templates/import.js'
import { celesteRoom } from './celeste.js'

const prologue = async () => {
  const { room, png, sha256 } = await celesteRoom()
  return { room, source: new Blob([png], { type: 'image/png' }), sha256 }
}

const recipeFor = (
  room: { width: number; height: number },
  sha256: string,
  changes: Partial<Pick<DitheretteTemplateRecipe, 'crop' | 'palette' | 'width' | 'height'>> = {},
  dither: DitheretteTemplateRecipe['ditherette']['dither'] = { family: 'none' },
): DitheretteTemplateRecipe => {
  const crop = changes.crop ?? { x: 0, y: 0, width: room.width, height: room.height }
  const width = changes.width ?? crop.width
  const height = changes.height ?? crop.height
  return {
    format: 1,
    processor: 'ditherette',
    processorVersion: 1,
    source: { sha256, width: room.width, height: room.height },
    crop,
    width,
    height,
    palette: changes.palette ?? PALETTE_RGB.map((_, index) => index),
    engine: 'cpu',
    ditherette: {
      version: 2,
      effects: [],
      output: { width, height, resize: { algorithm: 'nearest', anchor: 'top-left' } },
      alpha: { mode: 'preserve', threshold: 128 },
      match: 'oklab-euclidean',
      dither,
    },
  }
}

const origin = { originX: 0, originY: 0 }

describe('Ditherette recipes', () => {
  it('reproduces palette artwork exactly at identity scale', async () => {
    const { room, source, sha256 } = await prologue()
    const processed = await processRecipe(source, recipeFor(room, sha256), origin)
    expect(processed.indices).toEqual(room.indices)
    expect(processed.opaque).toBe(room.opaque)
  })

  it('crops before processing', async () => {
    const { room, source, sha256 } = await prologue()
    const crop = { x: 7, y: 5, width: 40, height: 30 }
    const processed = await processRecipe(source, recipeFor(room, sha256, { crop }), origin)
    const expected = new Uint8Array(crop.width * crop.height)
    for (let y = 0; y < crop.height; y++)
      for (let x = 0; x < crop.width; x++)
        expected[y * crop.width + x] = room.indices[(crop.y + y) * room.width + crop.x + x] ?? 0
    expect(processed.indices).toEqual(expected)
  })

  it('chooses only colours in the palette, and keeps transparency', async () => {
    const { room, source, sha256 } = await prologue()
    const palette = [0, 4, 9, 20]
    const processed = await processRecipe(
      source,
      recipeFor(
        room,
        sha256,
        { palette },
        {
          family: 'diffusion',
          kernel: 'floyd-steinberg',
          feedback: 'srgb-bytes',
          strength: 1,
          serpentine: true,
          placement: { mode: 'everywhere' },
        },
      ),
      origin,
    )
    const used = new Set(processed.indices)
    used.delete(TRANSPARENT_INDEX)
    expect([...used].every((index) => palette.includes(index))).toBe(true)
    const transparent = (indices: Uint8Array) =>
      indices.reduce((count, index) => count + Number(index === TRANSPARENT_INDEX), 0)
    expect(transparent(processed.indices)).toBe(transparent(room.indices))
  })

  it('scales to the recipe size', async () => {
    const { room, source, sha256 } = await prologue()
    const width = Math.ceil(room.width / 2)
    const height = Math.ceil(room.height / 2)
    const processed = await processRecipe(
      source,
      recipeFor(room, sha256, { width, height }),
      origin,
    )
    expect(processed.indices).toHaveLength(width * height)
  })
})
