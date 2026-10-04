import {
  MAX_TEMPLATE_RECIPE_PIXELS,
  parseTemplateRecipe,
  type TemplateRecipe,
  WORLD_PIXELS,
} from '@caelestis/shared'

/**
 * The Caelestis block inside an exported `.wplace` file.
 *
 * Wplace reads the fields it knows and ignores this one, so one file still opens in Wplace's own
 * editor. Caelestis reads the block instead: the outer `image` is the processed artwork, and the
 * block pins its exact placement, its hash, and the source and recipe that produced it.
 */
export interface CaelestisBlock {
  readonly format: typeof CAELESTIS_FORMAT
  readonly version: typeof CAELESTIS_VERSION
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  /** SHA-256 of the processed palette indices in the outer `image`. */
  readonly artwork: string
  /** The original PNG as a data URL, with the recipe that turned it into the artwork. */
  readonly authoring?: { readonly source: string; readonly recipe: TemplateRecipe }
}

export const CAELESTIS_FORMAT = 'caelestis-template'
export const CAELESTIS_VERSION = 1

const SHA256_HEX = /^[0-9a-f]{64}$/
const PNG_DATA_URL = /^data:image\/png;base64,/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCoordinate = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < WORLD_PIXELS

/**
 * Validate a block from a file. A newer format is refused outright rather than half-read; a
 * malformed one is refused too, since its artwork hash can no longer be trusted.
 */
export const parseCaelestisBlock = (value: unknown): CaelestisBlock => {
  if (!isRecord(value) || value.format !== CAELESTIS_FORMAT)
    throw new Error('the Caelestis template data in this file is unreadable')
  if (value.version !== CAELESTIS_VERSION)
    throw new Error('this file was made by a newer Caelestis. Update Caelestis to import it')
  const { originX, originY, width, height, artwork, authoring } = value
  if (
    !isCoordinate(originX) ||
    !isCoordinate(originY) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    Number(width) <= 0 ||
    Number(height) <= 0 ||
    Number(width) * Number(height) > MAX_TEMPLATE_RECIPE_PIXELS ||
    originX + Number(width) > WORLD_PIXELS ||
    originY + Number(height) > WORLD_PIXELS ||
    typeof artwork !== 'string' ||
    !SHA256_HEX.test(artwork)
  )
    throw new Error('the Caelestis template data in this file is unreadable')
  const block = {
    format: CAELESTIS_FORMAT,
    version: CAELESTIS_VERSION,
    originX,
    originY,
    width: Number(width),
    height: Number(height),
    artwork,
  } as const
  if (authoring === undefined) return block
  const recipe = isRecord(authoring) ? parseTemplateRecipe(authoring.recipe) : null
  if (
    recipe === null ||
    !isRecord(authoring) ||
    typeof authoring.source !== 'string' ||
    !PNG_DATA_URL.test(authoring.source)
  )
    throw new Error('the source and recipe in this file are unreadable')
  return { ...block, authoring: { source: authoring.source, recipe } }
}
