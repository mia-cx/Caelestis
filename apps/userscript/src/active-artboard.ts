import { sameTemplateSurface, type TemplateSurface } from '@caelestis/shared'
import { artboardGeometry } from './alliance-coordinates.js'
import { type ActiveAllianceSurface, activeAllianceSurface } from './alliance-surface.js'
import {
  type ArtboardPixels,
  NO_ARTBOARD_PIXELS,
  readArtboardPixels,
} from './gl/artboard-pixels.js'

/** Wplace's native art across the open alliance editor's whole surface, once its bounds are known. */
export const readActiveArtboard = (active: ActiveAllianceSurface): ArtboardPixels | null => {
  const geometry = artboardGeometry(active)
  return geometry === null ? null : readArtboardPixels(active, geometry)
}

/** The native art of `surface`: none unless the open editor shows it and knows its bounds. */
export const artboardPixelsFor = (surface: TemplateSurface): ArtboardPixels => {
  const active = activeAllianceSurface()
  if (active === null || !sameTemplateSurface(active.surface, surface)) return NO_ARTBOARD_PIXELS
  return readActiveArtboard(active) ?? NO_ARTBOARD_PIXELS
}
