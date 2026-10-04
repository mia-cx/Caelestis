import { describe, expect, it } from 'vitest'
import {
  parseTemplateRecipe,
  type TemplateRecipe,
  templateRecipeIdentity,
  templateRecipeJson,
} from '../index.js'

const recipe: TemplateRecipe = {
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
    const changes: readonly Partial<TemplateRecipe>[] = [
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
      { ...recipe, width: 5000, height: 5000 },
      { ...recipe, colorMetric: 'oklab' },
      { ...recipe, palette: [] },
      { ...recipe, palette: [2, 1] },
      { ...recipe, palette: [63] },
    ])
      expect(parseTemplateRecipe(invalid)).toBeNull()
  })
})
