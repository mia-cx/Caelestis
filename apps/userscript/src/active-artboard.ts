import { allianceBounds } from './alliance-coordinates.js'
import type { ActiveAllianceSurface } from './alliance-surface.js'
import { type ArtboardPixels, readArtboardPixels } from './gl/artboard-pixels.js'

/** Wplace's native art across the open alliance editor's whole surface, once its bounds are known. */
export const readActiveArtboard = (active: ActiveAllianceSurface): ArtboardPixels | null => {
  const bounds = allianceBounds(active)
  if (bounds === null) return null
  return readArtboardPixels(active, {
    originX: bounds.minX,
    originY: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  })
}
