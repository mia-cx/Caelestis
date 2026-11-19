import {
  parseWholeNumber,
  type TemplateSurface,
  templateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'

/**
 * The drawing surface a request names with `surface` and `allianceId`. Naming neither means the
 * world canvas. Query text and JSON numbers are both accepted for the alliance id.
 */
export const parseSurface = (kind: unknown, allianceId: unknown): TemplateSurface | null => {
  if (kind === undefined && allianceId === undefined) return WORLD_TEMPLATE_SURFACE
  if (kind === 'world') return allianceId === undefined ? WORLD_TEMPLATE_SURFACE : null
  return templateSurface(
    kind,
    typeof allianceId === 'number' ? allianceId : parseWholeNumber(allianceId),
  )
}
