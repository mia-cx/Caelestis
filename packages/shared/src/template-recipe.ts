import type { RecipeV2 } from 'ditherette'
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

/**
 * Largest template area. The userscript holds a template's pixels whole in memory, so this is also
 * its resident budget: anything larger could never be loaded. Every import path checks it before
 * allocating, so a small file cannot declare a huge image.
 */
export const MAX_TEMPLATE_PIXELS = 64 * 1024 * 1024

/**
 * `caelestis-nearest` is the plain-PNG importer: exact RGB nearest colour, no dithering.
 * `wplace-native` is Wplace's own worker, after Caelestis's floor nearest-neighbour resize.
 * `ditherette` is the template studio: a crop, then Ditherette's effects, resize, matching, and
 * dither. Version 1 is the exact `ditherette@1.0.0` build.
 * Bump a version whenever the same recipe would produce different indices.
 */
export const TEMPLATE_PROCESSORS = {
  'caelestis-nearest': 1,
  'wplace-native': 1,
  ditherette: 1,
} as const

export type TemplateProcessor = keyof typeof TEMPLATE_PROCESSORS

export type TemplateColorMetric = 'rgb' | 'lab' | 'compuphase' | 'ciede2000'

interface RecipeBase {
  readonly format: typeof TEMPLATE_RECIPE_FORMAT
  readonly processorVersion: number
  /** The original PNG, stored beside the recipe. */
  readonly source: { readonly sha256: string; readonly width: number; readonly height: number }
  /** Output size of the processed artwork. */
  readonly width: number
  readonly height: number
  /** Palette indices the quantiser may choose, ascending. Account presets are already resolved. */
  readonly palette: readonly number[]
}

/** The importers' recipes. Output follows the top-left, floor-based nearest-neighbour resize. */
export interface ImportTemplateRecipe extends RecipeBase {
  readonly processor: 'caelestis-nearest' | 'wplace-native'
  readonly colorMetric: TemplateColorMetric
  readonly dithering: boolean
  /** Decode through the browser's colour-managed path, as Wplace's legacy colours option does. */
  readonly legacyDecode: boolean
}

/** A source rectangle, in source pixels. */
export interface TemplateCrop {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where Ditherette processed the artwork. Each engine is deterministic, but they choose different
 * indices for the same recipe, so a replay must use the same one. `gpu` is Ditherette's GPU
 * engine with its parallel approximate error diffusion, as Ditherette web runs it.
 */
export type DitheretteEngine = 'cpu' | 'gpu'

/**
 * The template studio's recipe. Ditherette runs `ditherette` on the cropped source; its output
 * size is the recipe's. Servers cannot run Ditherette, so they check the shape and store it;
 * Ditherette validates every setting when a client replays it.
 */
export interface DitheretteTemplateRecipe extends RecipeBase {
  readonly processor: 'ditherette'
  readonly crop: TemplateCrop
  readonly engine: DitheretteEngine
  readonly ditherette: RecipeV2
}

export type TemplateRecipe = ImportTemplateRecipe | DitheretteTemplateRecipe

const SHA256_HEX = /^[0-9a-f]{64}$/
const COLOR_METRICS: readonly string[] = ['rgb', 'lab', 'compuphase', 'ciede2000']
const IMPORT_KEYS = [
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
const DITHERETTE_KEYS = [
  'format',
  'processor',
  'processorVersion',
  'source',
  'crop',
  'width',
  'height',
  'palette',
  'engine',
  'ditherette',
] as const
/** Tags and numbers, plus effect curves and masks; anything larger is not a Ditherette recipe. */
const MAX_DITHERETTE_JSON_BYTES = 64 * 1024
const MAX_DITHERETTE_DEPTH = 10

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

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
  Number(width) * Number(height) <= MAX_TEMPLATE_PIXELS

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

const isJson = (value: unknown, depth = 0): value is Json => {
  if (depth > MAX_DITHERETTE_DEPTH) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1))
  return (
    isRecord(value) &&
    isPlainObject(value) &&
    Object.values(value).every((item) => isJson(item, depth + 1))
  )
}

/**
 * An object literal's shape from any realm: storage can hand a sandboxed userscript the page's
 * objects, whose prototype is the page's `Object.prototype`, not this one.
 */
const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

/** Sorted keys at every level, so equal settings serialise to equal bytes. */
const canonicalJson = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(canonicalJson) as T
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  ) as T
}

const isCrop = (value: unknown, source: { width: number; height: number }): boolean =>
  isRecord(value) &&
  hasExactly(value, ['x', 'y', 'width', 'height']) &&
  Number.isSafeInteger(value.x) &&
  Number.isSafeInteger(value.y) &&
  Number(value.x) >= 0 &&
  Number(value.y) >= 0 &&
  isSize(value.width, value.height) &&
  Number(value.x) + Number(value.width) <= source.width &&
  Number(value.y) + Number(value.height) <= source.height

/** The output a Ditherette recipe declares must be the template's own size. */
const isDitheretteRecipe = (value: unknown, width: unknown, height: unknown): boolean => {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.effects) || !isJson(value))
    return false
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_DITHERETTE_JSON_BYTES)
    return false
  const { output } = value
  return isRecord(output) && output.width === width && output.height === height
}

/** Validate a recipe from a file or request. Unknown fields are refused, not ignored. */
export const parseTemplateRecipe = (value: unknown): TemplateRecipe | null => {
  if (!isRecord(value)) return null
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
    !isPalette(value.palette)
  )
    return null
  if (value.processor === 'ditherette') {
    return hasExactly(value, DITHERETTE_KEYS) &&
      isCrop(value.crop, { width: Number(source.width), height: Number(source.height) }) &&
      (value.engine === 'cpu' || value.engine === 'gpu') &&
      isDitheretteRecipe(value.ditherette, value.width, value.height)
      ? templateRecipe(value as unknown as DitheretteTemplateRecipe)
      : null
  }
  if (
    !hasExactly(value, IMPORT_KEYS) ||
    typeof value.colorMetric !== 'string' ||
    !COLOR_METRICS.includes(value.colorMetric) ||
    typeof value.dithering !== 'boolean' ||
    typeof value.legacyDecode !== 'boolean'
  )
    return null
  return templateRecipe(value as unknown as ImportTemplateRecipe)
}

/** A copy with keys in canonical order, so equal recipes serialise to equal bytes. */
export const templateRecipe = (recipe: TemplateRecipe): TemplateRecipe => {
  const source = {
    sha256: recipe.source.sha256,
    width: recipe.source.width,
    height: recipe.source.height,
  }
  if (recipe.processor === 'ditherette')
    return {
      format: recipe.format,
      processor: recipe.processor,
      processorVersion: recipe.processorVersion,
      source,
      crop: {
        x: recipe.crop.x,
        y: recipe.crop.y,
        width: recipe.crop.width,
        height: recipe.crop.height,
      },
      width: recipe.width,
      height: recipe.height,
      palette: [...recipe.palette],
      engine: recipe.engine,
      ditherette: canonicalJson(recipe.ditherette),
    }
  return {
    format: recipe.format,
    processor: recipe.processor,
    processorVersion: recipe.processorVersion,
    source,
    width: recipe.width,
    height: recipe.height,
    colorMetric: recipe.colorMetric,
    dithering: recipe.dithering,
    legacyDecode: recipe.legacyDecode,
    palette: [...recipe.palette],
  }
}

/** Canonical JSON, as stored by servers and written into `.caelestis` files. */
export const templateRecipeJson = (recipe: TemplateRecipe): string =>
  JSON.stringify(templateRecipe(recipe))

/** The cache key for artwork built from this recipe, covering source, settings, and processor. */
export const templateRecipeIdentity = async (recipe: TemplateRecipe): Promise<string> =>
  await sha256Hex(new TextEncoder().encode(templateRecipeJson(recipe)))
