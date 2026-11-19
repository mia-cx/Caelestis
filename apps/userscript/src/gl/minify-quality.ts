export const MEDIUM_MINIFY_FOOTPRINT = 2
export const FULL_MINIFY_FOOTPRINT = 3
const DENSE_MOVING_TEMPLATE_COUNT = 24

/** The settled renderer samples a 4x4 grid per output fragment at far zoom. */
export const SETTLED_TAP_CAP = 4

/**
 * Maximum distributed samples per overlay axis. During a drag, distributed samples retain
 * anti-moire coverage while leaving enough GPU budget for Wplace to move its own raster tiles; the
 * first settled frame returns to the full grid.
 */
export const minifyTapCap = (moving: boolean, visibleTemplates: number): 2 | 3 | 4 => {
  if (!moving) return SETTLED_TAP_CAP
  return visibleTemplates >= DENSE_MOVING_TEMPLATE_COUNT ? 2 : 3
}
