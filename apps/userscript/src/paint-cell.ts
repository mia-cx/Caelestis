import {
  latLngToCanvasPixel,
  type TemplateSurface,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { readActiveArtboard } from './active-artboard.js'
import { alliancePointAt } from './alliance-coordinates.js'
import { type ActiveAllianceSurface, activeAllianceSurface } from './alliance-surface.js'
import { getMap } from './map-handle.js'
import { canvasPixelAt } from './map-view.js'
import { nativePixelAt } from './native-pixels.js'
import { appearanceOf, displayTemplatesForSurface, isTemplateVisible } from './templates/catalog.js'
import { claimedHiddenFor } from './templates/colour-filter.js'
import { sourceXAt } from './templates/placement.js'
import { pixelAt } from './templates/sparse-pixels.js'
import { ensureTilePixels } from './tile-pixels.js'
import { worldNativePixels } from './world-native-pixels.js'
import { MAP_SURFACE } from './wplace-dom.js'

/**
 * The logical paint cell under a pointer, on the world map or the open alliance canvas, and the
 * unblended colours it holds: our overlay's index and the native pixel underneath. The colour
 * picker and shift-paint both read cells through here.
 */

/** The palette index our overlay claims at a logical canvas pixel, or null if it claims none. */
export const overlayIndexAt = (surface: TemplateSurface, x: number, y: number): number | null => {
  // Last match wins: the layer draws templates in this order, so the last one drawn is the one on
  // top, and the one on top is the one being pointed at.
  let found: number | null = null
  for (const template of displayTemplatesForSurface(surface)) {
    if (!isTemplateVisible(template)) continue
    const localX = sourceXAt(template, x)
    const localY = y - template.originY
    if (localX === null || localY < 0 || localY >= template.height) continue
    const cellX = Math.floor(localX)
    const cellY = Math.floor(localY)
    // A visible template under the pointer is resident; one still loading has nothing to pick.
    const pixels = template.artwork.pixels
    if (pixels === null) continue
    const index = pixelAt(pixels, cellX, cellY)
    if (index === TRANSPARENT_INDEX) continue
    if (claimedHiddenFor(appearanceOf(template)).includes(index)) continue
    found = index
  }
  return found
}

/** The exact base tile index. A cache miss starts a fetch and returns no colour for Wplace to pick. */
const placedIndexAt = (x: number, y: number, includeDraft = false): number | null => {
  const column = Math.floor(x)
  const row = Math.floor(y)
  const tile = {
    x: Math.floor(column / TILE_SIZE),
    y: Math.floor(row / TILE_SIZE),
  }
  ensureTilePixels(tile)
  return nativePixelAt(worldNativePixels(tile), column, row, includeDraft)?.index ?? null
}

/** A logical paint cell on the world map or the open alliance canvas, which `alliance` names. */
export interface PickerPoint {
  readonly surface: TemplateSurface
  readonly x: number
  readonly y: number
  readonly alliance: ActiveAllianceSurface | null
}

/** Resolve the logical paint cell using the native surface's projection. */
export const pickerPointAt = (
  target: Element,
  clientX: number,
  clientY: number,
): PickerPoint | null => {
  const alliance = activeAllianceSurface()
  if (alliance?.frame.contains(target)) {
    const point = alliancePointAt(alliance, clientX, clientY)
    return point === null ? null : { surface: alliance.surface, ...point, alliance }
  }
  if (target.closest(MAP_SURFACE) === null) return null
  // Rendered tile bounds can be rounded by half a screen pixel. Use the same projection as
  // Wplace's paint listener so a boundary never picks the next row or column prematurely.
  const map = getMap()
  const point =
    map === null
      ? canvasPixelAt(clientX, clientY)
      : latLngToCanvasPixel(map.unproject([clientX, clientY]))
  return point === null ? null : { surface: WORLD_TEMPLATE_SURFACE, ...point, alliance: null }
}

/** The alliance surface's exact native pixel, or null while it is unknown. */
const allianceIndexAt = (
  alliance: ActiveAllianceSurface,
  x: number,
  y: number,
  includeDraft: boolean,
): number | null => {
  const artboard = readActiveArtboard(alliance)
  return artboard === null ? null : (nativePixelAt(artboard, x, y, includeDraft)?.index ?? null)
}

/** What a pick answers: the overlay's colour on top, else the placed native pixel. */
export const pickedIndexAt = ({ surface, x, y, alliance }: PickerPoint): number | null => {
  const template = overlayIndexAt(surface, x, y)
  const pixelArt = alliance === null ? placedIndexAt(x, y) : allianceIndexAt(alliance, x, y, false)
  return template ?? pixelArt
}

/** Uncomposited colour under the brush on either surface, including the current native draft. */
export const paintIndexAt = ({ x, y, alliance }: PickerPoint): number | null =>
  alliance === null ? placedIndexAt(x, y, true) : allianceIndexAt(alliance, x, y, true)
