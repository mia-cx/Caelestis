import {
  canvasPixelToLatLng,
  sha256Hex,
  templateRecipe,
  uuidV7,
  WORLD_PIXELS,
} from '@caelestis/shared'
import type { TemplateAuthoring } from './authoring.js'
import { CAELESTIS_FORMAT, CAELESTIS_VERSION, type CaelestisBlock } from './caelestis-file.js'
import {
  appearanceOf,
  isCurrentTemplate,
  type PlacedTemplate,
  templateAsPng,
} from './local-store.js'
import { movingId } from './move.js'

export interface WplaceFile {
  readonly id: string
  readonly schemaVersion: '1'
  readonly name: string
  readonly opacity: number
  readonly image: {
    readonly dataUrl: string
    readonly width: number
    readonly height: number
  }
  readonly bounds: {
    readonly north: number
    readonly south: number
    readonly west: number
    readonly east: number
  }
  readonly colorMetric: 'lab'
  readonly dithering: false
  readonly useLegacyColors: false
  readonly colorPaletteMode: 'all'
  readonly order: number
  readonly locked: false
  readonly hasPlaced: true
  readonly visible: boolean
  /** Ignored by Wplace. Caelestis imports exactly this artwork, source, and recipe. */
  readonly caelestis?: CaelestisBlock
}

const BASE64_CHUNK = 0x8000

/**
 * A PNG data URL. Reads bytes rather than using `FileReader`, which refuses a stored source: that
 * Blob comes back from the page's IndexedDB, in a different realm from a sandboxed userscript.
 */
const blobAsDataUrl = async (blob: Pick<Blob, 'arrayBuffer'>): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK))
  return `data:image/png;base64,${btoa(binary)}`
}

/** The native editor record for one placed Caelestis template. */
export const wplaceFile = (
  template: PlacedTemplate,
  dataUrl: string,
  opacity: number,
): WplaceFile => {
  const northWest = canvasPixelToLatLng({ x: template.originX, y: template.originY })
  const southEast = canvasPixelToLatLng({
    x: template.originX + template.width,
    y: template.originY + template.height,
  })
  return {
    id: uuidV7(),
    schemaVersion: '1',
    name: template.name,
    opacity,
    image: { dataUrl, width: template.width, height: template.height },
    bounds: {
      north: northWest.lat,
      south: southEast.lat,
      west: northWest.lng,
      east: southEast.lng,
    },
    colorMetric: 'lab',
    dithering: false,
    useLegacyColors: false,
    colorPaletteMode: 'all',
    order: template.sortOrder ?? 0,
    locked: false,
    hasPlaced: true,
    visible: template.visible,
  }
}

/** Pin exact placement and artwork, and carry the authoring inputs when they still apply. */
const caelestisBlock = async (
  template: PlacedTemplate,
  authoring: TemplateAuthoring | null,
): Promise<{ caelestis?: CaelestisBlock }> => {
  // Antimeridian-wrapped server artwork has no single origin; Caelestis reads its bounds instead.
  if (template.originX + template.width > WORLD_PIXELS) return {}
  const block = {
    format: CAELESTIS_FORMAT,
    version: CAELESTIS_VERSION,
    originX: template.originX,
    originY: template.originY,
    width: template.width,
    height: template.height,
    artwork: await sha256Hex(template.indices),
  } as const
  if (authoring === null || authoring.artwork !== block.artwork) return { caelestis: block }
  const source = await blobAsDataUrl(authoring.source)
  return {
    caelestis: { ...block, authoring: { source, recipe: templateRecipe(authoring.recipe) } },
  }
}

/**
 * Encode a current placed template as the JSON file Wplace's own editor imports, with a Caelestis
 * block that keeps its processed artwork, source, and recipe for the next Caelestis import.
 */
export const templateAsWplace = async (
  template: PlacedTemplate,
  authoring: TemplateAuthoring | null,
): Promise<Blob | null> => {
  if (!isCurrentTemplate(template) || !template.everPlaced || movingId() === template.id)
    return null
  const png = await templateAsPng(template)
  if (png === null || !isCurrentTemplate(template) || movingId() === template.id) return null
  const dataUrl = await blobAsDataUrl(png)
  const block = await caelestisBlock(template, authoring)
  if (!isCurrentTemplate(template) || movingId() === template.id) return null
  const record = { ...wplaceFile(template, dataUrl, appearanceOf(template).opacity), ...block }
  return new Blob([`${JSON.stringify(record, null, 2)}\n`], { type: 'application/json' })
}

export const wplaceFilename = (name: string): string => {
  const withoutExtension = name.replace(/\.[^.]+$/, '')
  const base = [...withoutExtension]
    .map((character) =>
      character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character,
    )
    .join('')
    .trim()
  return `${base.length === 0 ? 'template' : base}.wplace`
}
