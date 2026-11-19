import {
  type TemplateSurface,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  templateSurfaceBounds,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
  WPLACE_PALETTE,
} from '@caelestis/shared'
import type { SparsePixels } from './sparse-pixels.js'

/** Where a template sits, without its pixels. */
export interface Placement {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  readonly surface?: TemplateSurface
  readonly wrapX?: boolean
  readonly serverUrl?: string
}

/**
 * Throw a RangeError unless the template fits its surface at this origin.
 *
 * Only server templates may wrap past the world's east edge: their source continues at x=0.
 */
export const validatePlacement = (
  template: Placement & { readonly indices?: Uint8Array },
  originX = template.originX,
  originY = template.originY,
): void => {
  if (!Number.isSafeInteger(originX) || !Number.isSafeInteger(originY)) {
    throw new RangeError('template origin must be whole canvas pixels')
  }
  if (
    !Number.isSafeInteger(template.width) ||
    !Number.isSafeInteger(template.height) ||
    template.width <= 0 ||
    template.height <= 0 ||
    (template.indices !== undefined && template.indices.length !== template.width * template.height)
  ) {
    throw new RangeError('template dimensions do not match its pixels')
  }
  const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
  if (surface.kind !== 'world') {
    const bounds = templateSurfaceBounds(surface)
    if (
      bounds === null ||
      originX < bounds.minX ||
      originY < bounds.minY ||
      originX + template.width > bounds.maxX ||
      originY + template.height > bounds.maxY
    ) {
      throw new RangeError(`template is outside the ${surface.kind} canvas`)
    }
    return
  }
  if (originX < 0 || originY < 0) throw new RangeError('template origin is outside the canvas')
  if (originX + template.width > WORLD_PIXELS) {
    if (
      template.wrapX !== true ||
      typeof template.serverUrl !== 'string' ||
      template.width >= WORLD_PIXELS ||
      originX + template.width > WORLD_PIXELS * 2
    ) {
      throw new RangeError('template runs past the east edge')
    }
  }
  if (originY + template.height > WORLD_PIXELS)
    throw new RangeError('template runs past the south edge')
}

const yieldToBrowser = async (): Promise<void> => {
  const browserScheduler = (
    globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler
  if (browserScheduler?.yield !== undefined) {
    await browserScheduler.yield()
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/**
 * Validate indexed pixels against their placement and return the world tiles (`x/y`) they paint.
 *
 * Throws a RangeError when the placement, dimensions, palette indices or opaque count disagree.
 * Off the world surface no tiles are tracked. Yields to the browser through large images.
 */
export const paintedTileKeys = async (
  template: Placement & { readonly opaque: number },
  pixels: SparsePixels,
): Promise<ReadonlySet<string>> => {
  validatePlacement(template)
  if (pixels.width !== template.width || pixels.height !== template.height) {
    throw new RangeError('template dimensions do not match its pixels')
  }
  await yieldToBrowser()
  let opaque = 0
  const tiles = new Set<string>()
  const worldTilesWide = Math.ceil(WORLD_PIXELS / TILE_SIZE)
  const world = (template.surface ?? WORLD_TEMPLATE_SURFACE).kind === 'world'
  let scanned = 0
  for (const chunk of pixels.chunks.values()) {
    let lastPaintedTile = -1
    for (let pixel = 0; pixel < chunk.indices.length; pixel++) {
      const index = chunk.indices[pixel] ?? TRANSPARENT_INDEX
      if (index === TRANSPARENT_INDEX) continue
      if (index >= WPLACE_PALETTE.length) throw new RangeError('template palette index is invalid')
      opaque++
      if (!world) continue
      const unwrappedX = template.originX + chunk.x + (pixel % chunk.width)
      const worldX = unwrappedX >= WORLD_PIXELS ? unwrappedX - WORLD_PIXELS : unwrappedX
      const tileX = Math.floor(worldX / TILE_SIZE)
      const tileY = Math.floor(
        (template.originY + chunk.y + Math.floor(pixel / chunk.width)) / TILE_SIZE,
      )
      const tile = tileY * worldTilesWide + tileX
      if (tile !== lastPaintedTile) {
        lastPaintedTile = tile
        tiles.add(`${tileX}/${tileY}`)
      }
    }
    scanned += chunk.indices.length
    if (scanned >= 250_000) {
      scanned = 0
      await yieldToBrowser()
    }
  }
  if (opaque !== template.opaque) throw new RangeError('template opaque count is invalid')
  return tiles
}

export interface HorizontalPlacement {
  readonly originX: number
  readonly width: number
  readonly wrapX?: boolean
}

export interface HorizontalSpan {
  readonly worldStart: number
  readonly worldEnd: number
  readonly sourceStart: number
  readonly sourceEnd: number
}

/** Contiguous world runs for a source whose last columns may wrap through the antimeridian. */
export const horizontalSpans = (template: HorizontalPlacement): readonly HorizontalSpan[] => {
  if (template.wrapX !== true || template.originX + template.width <= WORLD_PIXELS) {
    return [
      {
        worldStart: template.originX,
        worldEnd: template.originX + template.width,
        sourceStart: 0,
        sourceEnd: template.width,
      },
    ]
  }
  const eastWidth = WORLD_PIXELS - template.originX
  return [
    {
      worldStart: template.originX,
      worldEnd: WORLD_PIXELS,
      sourceStart: 0,
      sourceEnd: eastWidth,
    },
    {
      worldStart: 0,
      worldEnd: template.width - eastWidth,
      sourceStart: eastWidth,
      sourceEnd: template.width,
    },
  ]
}

export const horizontalSpanAt = (
  template: HorizontalPlacement,
  worldX: number,
): HorizontalSpan | null =>
  horizontalSpans(template).find((span) => worldX >= span.worldStart && worldX < span.worldEnd) ??
  null

/** Source column at a world x coordinate, or null when the template does not cover it. */
export const sourceXAt = (template: HorizontalPlacement, worldX: number): number | null => {
  const span = horizontalSpanAt(template, worldX)
  return span === null ? null : span.sourceStart + worldX - span.worldStart
}

export const horizontalCentre = (template: HorizontalPlacement): number =>
  template.wrapX === true
    ? (template.originX + template.width / 2) % WORLD_PIXELS
    : template.originX + template.width / 2

/** Shortest signed distance on the wrapping x axis. */
export const wrappedDeltaX = (from: number, to: number): number => {
  const direct = to - from
  if (Math.abs(direct) <= WORLD_PIXELS / 2) return direct
  return direct > 0 ? direct - WORLD_PIXELS : direct + WORLD_PIXELS
}
