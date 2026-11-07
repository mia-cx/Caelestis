import { templateSurfaceBounds } from '@caelestis/shared'
import type { ActiveAllianceSurface } from './alliance-surface.js'

export const allianceBounds = (active: ActiveAllianceSurface) =>
  active.surface.kind === 'alliance-headquarters'
    ? active.bounds
    : templateSurfaceBounds(active.surface)

/**
 * Convert a pointer in the active transformed frame to its exact alliance canvas coordinate, as
 * Wplace's own input does. Wplace offsets the frame from the stage's border box, but the frame sits
 * inside the stage's border, so its drawn position is one border width away from that origin.
 */
export const alliancePointAt = (
  active: ActiveAllianceSurface,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  const bounds = allianceBounds(active)
  const rect = active.frame.getBoundingClientRect()
  const border = getComputedStyle(active.stage)
  const left = rect.left - (Number.parseFloat(border.borderLeftWidth) || 0)
  const top = rect.top - (Number.parseFloat(border.borderTopWidth) || 0)
  if (
    bounds === null ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    clientX < left ||
    clientX >= left + rect.width ||
    clientY < top ||
    clientY >= top + rect.height
  )
    return null
  return {
    x: bounds.minX + ((clientX - left) / rect.width) * (bounds.maxX - bounds.minX),
    y: bounds.minY + ((clientY - top) / rect.height) * (bounds.maxY - bounds.minY),
  }
}
