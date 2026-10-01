import {
  type RegionShapePixels,
  sameTemplateSurface,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
  WPLACE_PALETTE,
} from '@caelestis/shared'
import { allianceBounds } from '../alliance-coordinates.js'
import { activeAllianceSurface } from '../alliance-surface.js'
import { readArtboardPixels, refreshArtboardPixels } from '../gl/artboard-pixels.js'
import {
  type NativePixelSnapshot,
  type NativePixelWindow,
  nativePixelWindow,
} from '../native-pixels.js'
import { loadCommittedTilePixels, UNPAINTED } from '../tile-transform.js'
import type { PlacedTemplate } from './local-store.js'

const overlayWindow = (
  indices: Uint8Array,
  width: number,
  x: number,
  y: number,
  art: NativePixelWindow,
): void => {
  for (let row = 0; row < art.height; row++) {
    for (let column = 0; column < art.width; column++) {
      const source = row * art.width + column
      const index = art.indices[source]
      if (
        art.known[source] !== 1 ||
        index === undefined ||
        (index !== TRANSPARENT_INDEX && WPLACE_PALETTE[index] === undefined)
      ) {
        throw new Error(
          `Committed artwork is unavailable at ${art.x + column}, ${art.y + row}. Load that area and try again.`,
        )
      }
      if (index !== TRANSPARENT_INDEX) indices[(y + row) * width + x + column] = index
    }
  }
}

/** Composite only known committed art over a template, preserving transparent target pixels as the bottom layer. */
export const compositeCommittedArtwork = (
  template: PlacedTemplate,
  snapshot: NativePixelSnapshot,
): Uint8Array => {
  const indices = template.indices.slice()
  const art = nativePixelWindow(
    { committed: snapshot.committed, draft: [] },
    {
      x: template.originX,
      y: template.originY,
      width: template.width,
      height: template.height,
    },
  )
  overlayWindow(indices, template.width, 0, 0, art)
  return indices
}

/** Capture complete committed art at the saved placement, including world tile crossings and east-edge wrapping. */
export const captureCurrentArtwork = async (template: PlacedTemplate): Promise<Uint8Array> => {
  const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
  if (surface.kind !== 'world') {
    const active = activeAllianceSurface()
    const bounds = active === null ? null : allianceBounds(active)
    if (active === null || bounds === null || !sameTemplateSurface(surface, active.surface)) {
      throw new Error('Open this template’s alliance canvas before updating it.')
    }
    const geometry = {
      originX: bounds.minX,
      originY: bounds.minY,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
    }
    await refreshArtboardPixels(active, geometry)
    if (activeAllianceSurface() !== active)
      throw new Error('The alliance canvas changed. Try again.')
    return compositeCommittedArtwork(template, readArtboardPixels(active, geometry))
  }
  return captureWorldArtwork(template)
}

/** Composite committed world art over a placement, loading every tile it touches first. */
const captureWorldArtwork = async (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
  mask?: Uint8Array,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const indices = template.indices.slice()
  for (let y = 0; y < template.height; ) {
    const worldY = template.originY + y
    const height = Math.min(TILE_SIZE - (worldY % TILE_SIZE), template.height - y)
    for (let x = 0; x < template.width; ) {
      const worldX = (template.originX + x) % WORLD_PIXELS
      const width = Math.min(TILE_SIZE - (worldX % TILE_SIZE), template.width - x)
      let selected = mask === undefined
      for (let row = 0; !selected && row < height; row++) {
        selected =
          mask
            ?.subarray((y + row) * template.width + x, (y + row) * template.width + x + width)
            .includes(1) === true
      }
      if (!selected) {
        x += width
        continue
      }
      const tile = { x: Math.floor(worldX / TILE_SIZE), y: Math.floor(worldY / TILE_SIZE) }
      signal?.throwIfAborted()
      const pixels = await loadCommittedTilePixels(tile)
      signal?.throwIfAborted()
      if (pixels === null)
        throw new Error(
          `Could not load committed Wplace tile ${tile.x}/${tile.y}. Load that area and try again.`,
        )
      const art = nativePixelWindow(
        {
          committed: [
            {
              x: tile.x * TILE_SIZE,
              y: tile.y * TILE_SIZE,
              width: TILE_SIZE,
              height: TILE_SIZE,
              pixels,
              emptyIndex: UNPAINTED,
            },
          ],
          draft: [],
        },
        { x: worldX, y: worldY, width, height },
      )
      overlayWindow(indices, template.width, x, y, art)
      x += width
    }
    y += height
  }
  return indices
}

/**
 * A world template with committed art merged in only where a selection covers it, by the same
 * rule as `captureCurrentArtwork`. Pixels outside the selection keep the template's. Only tiles
 * under selected template pixels load.
 */
export const captureTemplateArea = async (
  template: Pick<PlacedTemplate, 'originX' | 'originY' | 'width' | 'height' | 'indices'>,
  { rect, mask }: RegionShapePixels,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const area = new Uint8Array(template.width * template.height)
  for (let y = 0; y < template.height; y++) {
    const row = template.originY + y - rect.y
    if (row < 0 || row >= rect.h) continue
    for (let x = 0; x < template.width; x++) {
      const column = ((template.originX + x) % WORLD_PIXELS) - rect.x
      if (column >= 0 && column < rect.w && mask[row * rect.w + column] === 1)
        area[y * template.width + x] = 1
    }
  }
  if (!area.includes(1)) throw new Error('Select part of the template to update.')
  const indices = await captureWorldArtwork(template, area, signal)
  template.indices.forEach((index, at) => {
    if (area[at] !== 1) indices[at] = index
  })
  return indices
}

/**
 * Committed world art under a selection, one image pixel per canvas pixel over the selection's
 * bounds and transparent outside its mask. Only tiles with selected pixels need to load; a missing
 * selected tile fails the capture rather than reading as transparent.
 */
export const captureSelectedArtwork = async (
  { rect, mask }: RegionShapePixels,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > WORLD_PIXELS || rect.y + rect.h > WORLD_PIXELS)
    throw new Error('Keep the capture selection inside the world canvas.')
  const indices = await captureWorldArtwork(
    {
      originX: rect.x,
      originY: rect.y,
      width: rect.w,
      height: rect.h,
      indices: new Uint8Array(rect.w * rect.h).fill(TRANSPARENT_INDEX),
    },
    mask,
    signal,
  )
  for (let at = 0; at < indices.length; at++) if (mask[at] !== 1) indices[at] = TRANSPARENT_INDEX
  return indices
}
