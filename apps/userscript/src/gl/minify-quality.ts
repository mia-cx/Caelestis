export const MEDIUM_MINIFY_FOOTPRINT = 2
export const FULL_MINIFY_FOOTPRINT = 3
const DENSE_MOVING_TEMPLATE_COUNT = 24

/** Maximum distributed samples per overlay axis while moving; settled rendering always uses four. */
export const movingOverlayTapCap = (visibleTemplates: number): 2 | 3 =>
  visibleTemplates >= DENSE_MOVING_TEMPLATE_COUNT ? 2 : 3
