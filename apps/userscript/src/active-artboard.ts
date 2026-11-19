import { artboardGeometry } from './alliance-coordinates.js'
import type { ActiveAllianceSurface } from './alliance-surface.js'
import { type ArtboardPixels, readArtboardPixels } from './gl/artboard-pixels.js'

/** Wplace's native art across the open alliance editor's whole surface, once its bounds are known. */
export const readActiveArtboard = (active: ActiveAllianceSurface): ArtboardPixels | null => {
  const geometry = artboardGeometry(active)
  return geometry === null ? null : readArtboardPixels(active, geometry)
}
