import { sha256Hex } from './hash.js'
import { TRANSPARENT_INDEX } from './palette.js'
import { WORLD_PIXELS } from './tiles.js'

/**
 * The authoring inputs behind a template's processed artwork.
 *
 * A recipe names the exact source bytes and every processing choice, so one processor version
 * turns the same source into the same palette indices. Its identity keys the processed artwork:
 * a different source, setting, palette, or processor version is a different identity, so artwork
 * built for one recipe is never served for another.
 */
export const TEMPLATE_RECIPE_FORMAT = 1

/** Retained source PNGs. Larger imports still work, without keeping their source. */
export const MAX_TEMPLATE_SOURCE_BYTES = 32 * 1024 * 1024

/** Matches the importer's decode budget. */
export const MAX_TEMPLATE_RECIPE_PIXELS = 16 * 1024 * 1024

/**
 * `caelestis-nearest` is the plain-PNG importer: exact RGB nearest colour, no dithering.
 * `wplace-native` is Wplace's own worker, after Caelestis's floor nearest-neighbour resize.
 * Bump a version whenever the same recipe would produce different indices.
 */
export const TEMPLATE_PROCESSORS = { 'caelestis-nearest': 1, 'wplace-native': 1 } as const

export type TemplateProcessor = keyof typeof TEMPLATE_PROCESSORS

export type TemplateColorMetric = 'rgb' | 'lab' | 'compuphase' | 'ciede2000'

export interface TemplateRecipe {
  readonly format: typeof TEMPLATE_RECIPE_FORMAT
  readonly processor: TemplateProcessor
  readonly processorVersion: number
  /** The original PNG, stored beside the recipe. */
  readonly source: { readonly sha256: string; readonly width: number; readonly height: number }
  /** Output size after the top-left, floor-based nearest-neighbour resize. */
  readonly width: number
  readonly height: number
  readonly colorMetric: TemplateColorMetric
  readonly dithering: boolean
  /** Decode through the browser's colour-managed path, as Wplace's legacy colours option does. */
  readonly legacyDecode: boolean
  /** Palette indices the quantiser may choose, ascending. Account presets are already resolved. */
  readonly palette: readonly number[]
}

const SHA256_HEX = /^[0-9a-f]{64}$/
const COLOR_METRICS: readonly string[] = ['rgb', 'lab', 'compuphase', 'ciede2000']
const RECIPE_KEYS = [
  'format',
  'processor',
  'processorVersion',
  'source',
  'width',
  'height',
  'colorMetric',
  'dithering',
  'legacyDecode',
  'palette',
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const isSize = (width: unknown, height: unknown): boolean =>
  Number.isSafeInteger(width) &&
  Number.isSafeInteger(height) &&
  Number(width) > 0 &&
  Number(height) > 0 &&
  Number(width) <= WORLD_PIXELS &&
  Number(height) <= WORLD_PIXELS &&
  Number(width) * Number(height) <= MAX_TEMPLATE_RECIPE_PIXELS

const isPalette = (value: unknown): value is readonly number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (index, position) =>
      Number.isSafeInteger(index) &&
      index >= 0 &&
      index < TRANSPARENT_INDEX &&
      (position === 0 || index > value[position - 1]),
  )

/** Validate a recipe from a file or request. Unknown fields are refused, not ignored. */
export const parseTemplateRecipe = (value: unknown): TemplateRecipe | null => {
  if (!isRecord(value) || !hasExactly(value, RECIPE_KEYS)) return null
  const { source } = value
  if (
    value.format !== TEMPLATE_RECIPE_FORMAT ||
    typeof value.processor !== 'string' ||
    !Object.hasOwn(TEMPLATE_PROCESSORS, value.processor) ||
    !Number.isSafeInteger(value.processorVersion) ||
    Number(value.processorVersion) < 1 ||
    !isRecord(source) ||
    !hasExactly(source, ['sha256', 'width', 'height']) ||
    typeof source.sha256 !== 'string' ||
    !SHA256_HEX.test(source.sha256) ||
    !isSize(source.width, source.height) ||
    !isSize(value.width, value.height) ||
    typeof value.colorMetric !== 'string' ||
    !COLOR_METRICS.includes(value.colorMetric) ||
    typeof value.dithering !== 'boolean' ||
    typeof value.legacyDecode !== 'boolean' ||
    !isPalette(value.palette)
  )
    return null
  return templateRecipe(value as unknown as TemplateRecipe)
}

/** A copy with keys in canonical order, so equal recipes serialise to equal bytes. */
export const templateRecipe = (recipe: TemplateRecipe): TemplateRecipe => ({
  format: recipe.format,
  processor: recipe.processor,
  processorVersion: recipe.processorVersion,
  source: {
    sha256: recipe.source.sha256,
    width: recipe.source.width,
    height: recipe.source.height,
  },
  width: recipe.width,
  height: recipe.height,
  colorMetric: recipe.colorMetric,
  dithering: recipe.dithering,
  legacyDecode: recipe.legacyDecode,
  palette: [...recipe.palette],
})

/** Canonical JSON, as stored by servers and written into `.caelestis` files. */
export const templateRecipeJson = (recipe: TemplateRecipe): string =>
  JSON.stringify(templateRecipe(recipe))

/** The cache key for artwork built from this recipe, covering source, settings, and processor. */
export const templateRecipeIdentity = async (recipe: TemplateRecipe): Promise<string> =>
  await sha256Hex(new TextEncoder().encode(templateRecipeJson(recipe)))
