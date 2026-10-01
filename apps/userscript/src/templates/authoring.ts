import {
  MAX_TEMPLATE_SOURCE_BYTES,
  parseTemplateRecipe,
  sha256Hex,
  type TemplateRecipe,
} from '@caelestis/shared'
import { isStoredBlob } from '../page-world.js'

/** Authoring inputs kept beside a template's processed indices. */
export interface TemplateAuthoring {
  /** The original PNG. IndexedDB keeps it on disk until something reads it. */
  readonly source: Blob
  readonly recipe: TemplateRecipe
  /** SHA-256 of the indices this recipe produced. Edited pixels no longer match it. */
  readonly artwork: string
}

const SHA256_HEX = /^[0-9a-f]{64}$/

const isBlob = (value: unknown): value is Blob =>
  isStoredBlob(value) &&
  typeof (value as Blob).type === 'string' &&
  typeof (value as Blob).slice === 'function'

/** Authoring read back from storage or a file, if it is whole and describes a template this size. */
export const storedAuthoring = (
  value: unknown,
  size: { readonly width?: unknown; readonly height?: unknown },
): TemplateAuthoring | null => {
  if (typeof value !== 'object' || value === null) return null
  const { source, recipe: rawRecipe, artwork } = value as Record<string, unknown>
  const recipe = parseTemplateRecipe(rawRecipe)
  return isBlob(source) &&
    source.size <= MAX_TEMPLATE_SOURCE_BYTES &&
    recipe !== null &&
    recipe.width === size.width &&
    recipe.height === size.height &&
    typeof artwork === 'string' &&
    SHA256_HEX.test(artwork)
    ? { source, recipe, artwork }
    : null
}

/** Authoring that still describes these pixels. Edited artwork no longer matches its recipe. */
export const currentAuthoring = async (template: {
  readonly indices: Uint8Array
  readonly authoring?: TemplateAuthoring
}): Promise<TemplateAuthoring | null> =>
  template.authoring !== undefined &&
  (await sha256Hex(template.indices)) === template.authoring.artwork
    ? template.authoring
    : null
