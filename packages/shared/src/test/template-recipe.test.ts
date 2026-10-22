import { describe, expect, it } from 'vitest'
import {
  type DitheretteTemplateRecipe,
  type ImportTemplateRecipe,
  parseTemplateRecipe,
  type TemplateRecipe,
  templateRecipeIdentity,
  templateRecipeJson,
  WORLD_PIXELS,
} from '../index.js'

const recipe: ImportTemplateRecipe = {
  format: 1,
  processor: 'wplace-native',
  processorVersion: 1,
  source: { sha256: 'a'.repeat(64), width: 1024, height: 1024 },
  width: 113,
  height: 113,
  colorMetric: 'lab',
  dithering: false,
  legacyDecode: false,
  palette: [0, 1, 2],
}

describe('template recipes', () => {
  it('round trips through canonical JSON regardless of key order', async () => {
    const reordered = Object.fromEntries(Object.entries(recipe).reverse())
    const parsed = parseTemplateRecipe(reordered)
    expect(parsed).toEqual(recipe)
    expect(templateRecipeJson(parsed as TemplateRecipe)).toBe(templateRecipeJson(recipe))
    expect(await templateRecipeIdentity(parsed as TemplateRecipe)).toBe(
      await templateRecipeIdentity(recipe),
    )
  })

  it('gives every processing input its own identity', async () => {
    const changes: readonly Partial<ImportTemplateRecipe>[] = [
      { source: { ...recipe.source, sha256: 'b'.repeat(64) } },
      { width: 112 },
      { dithering: true },
      { colorMetric: 'ciede2000' },
      { legacyDecode: true },
      { palette: [0, 1] },
      { processor: 'caelestis-nearest' },
      { processorVersion: 2 },
    ]
    const identities = await Promise.all(
      [recipe, ...changes.map((change) => ({ ...recipe, ...change }))].map(templateRecipeIdentity),
    )
    expect(new Set(identities).size).toBe(identities.length)
  })

  it('refuses recipes it cannot reproduce', () => {
    for (const invalid of [
      { ...recipe, extra: true },
      { ...recipe, format: 2 },
      { ...recipe, processor: 'ditherette' },
      { ...recipe, processorVersion: 0 },
      { ...recipe, source: { ...recipe.source, sha256: 'A'.repeat(64) } },
      { ...recipe, width: 0 },
      { ...recipe, width: WORLD_PIXELS + 1 },
      { ...recipe, width: 8193, height: 8192 },
      { ...recipe, colorMetric: 'oklab' },
      { ...recipe, palette: [] },
      { ...recipe, palette: [2, 1] },
      { ...recipe, palette: [63] },
    ])
      expect(parseTemplateRecipe(invalid)).toBeNull()
  })

  it('accepts templates up to 64 Mi pixels', () => {
    const large = { ...recipe, width: 8192, height: 8192 }
    expect(parseTemplateRecipe(large)).toEqual(large)
  })
})

const ditherette: DitheretteTemplateRecipe = {
  format: 1,
  processor: 'ditherette',
  processorVersion: 1,
  source: { sha256: 'c'.repeat(64), width: 64, height: 48 },
  crop: { x: 8, y: 4, width: 40, height: 30 },
  width: 20,
  height: 15,
  palette: [0, 4, 9],
  ditherette: {
    version: 1,
    output: { width: 20, height: 15, resize: { algorithm: 'area' } },
    alpha: { mode: 'preserve', threshold: 128 },
    match: 'oklab-euclidean',
    dither: {
      family: 'diffusion',
      kernel: 'floyd-steinberg',
      feedback: 'srgb-bytes',
      strength: 1,
      serpentine: true,
      placement: { mode: 'everywhere' },
    },
  },
}

/** Reverse every object's keys, at every depth. */
const reversed = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reversed)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reversed(item)]),
        )
      : value

describe('Ditherette recipes', () => {
  it('round trips through canonical JSON at every depth', async () => {
    const parsed = parseTemplateRecipe(reversed(ditherette))
    expect(parsed).toEqual(ditherette)
    expect(templateRecipeJson(parsed as TemplateRecipe)).toBe(templateRecipeJson(ditherette))
    expect(await templateRecipeIdentity(parsed as TemplateRecipe)).toBe(
      await templateRecipeIdentity(ditherette),
    )
  })

  it('gives crops and processing settings their own identity', async () => {
    const changed: readonly DitheretteTemplateRecipe[] = [
      { ...ditherette, crop: { ...ditherette.crop, x: 9 } },
      { ...ditherette, ditherette: { ...ditherette.ditherette, match: 'cielab-ciede2000' } },
      { ...ditherette, ditherette: { ...ditherette.ditherette, dither: { family: 'none' } } },
    ]
    const identities = await Promise.all([ditherette, ...changed].map(templateRecipeIdentity))
    expect(new Set(identities).size).toBe(identities.length)
  })

  it('refuses crops outside the source and outputs that disagree with the template', () => {
    for (const invalid of [
      { ...ditherette, crop: { ...ditherette.crop, x: 30 } },
      { ...ditherette, crop: { ...ditherette.crop, width: 0 } },
      { ...ditherette, crop: undefined },
      { ...ditherette, colorMetric: 'lab' },
      { ...ditherette, width: 21 },
      { ...ditherette, ditherette: { ...ditherette.ditherette, version: 2 } },
      { ...ditherette, ditherette: { ...ditherette.ditherette, note: 'x'.repeat(4096) } },
      { ...ditherette, ditherette: { ...ditherette.ditherette, alpha: { threshold: Number.NaN } } },
    ])
      expect(parseTemplateRecipe(invalid)).toBeNull()
  })
})
