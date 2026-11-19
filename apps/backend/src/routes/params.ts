import {
  MAX_NAME_LENGTH,
  parseWholeNumber,
  type TemplateSurface,
  templateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { Context } from 'hono'

/** A non-negative integer, from a JSON number or query text. */
export const wholeNumber = (value: unknown): number | null =>
  typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0
      ? value
      : null
    : parseWholeNumber(value)

/**
 * The drawing surface a request names with `surface` and `allianceId`. Naming neither means the
 * world canvas.
 */
export const parseSurface = (kind: unknown, allianceId: unknown): TemplateSurface | null => {
  if (kind === undefined && allianceId === undefined) return WORLD_TEMPLATE_SURFACE
  if (kind === 'world') return allianceId === undefined ? WORLD_TEMPLATE_SURFACE : null
  return templateSurface(kind, wholeNumber(allianceId))
}

/** The refusal for a surface that `parseSurface` rejected; `field` names the kind's parameter. */
export const invalidSurface = (field: 'surface' | 'surfaceKind') =>
  `${field} must be world or an alliance surface with a positive allianceId`

/** The request's JSON body when it is an object, or null for any other body. */
export const jsonObject = async (c: Context): Promise<Partial<Record<string, unknown>> | null> => {
  const body: unknown = await c.req.json().catch(() => null)
  return typeof body === 'object' && body !== null ? body : null
}

export const isName = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH

export const INVALID_NAME = `name must be 1..${MAX_NAME_LENGTH} characters`

export const INVALID_ID = 'id must be a canonical lowercase UUIDv7'

/** A patch flag: absent, or a boolean. */
export const isOptionalBoolean = (value: unknown): value is boolean | undefined =>
  value === undefined || typeof value === 'boolean'

/**
 * The refusal for a patch that sets none of `fields`, or null. A patch of nothing is always a
 * mistake on the caller's side, and answering 200 would report success for no change.
 */
export const emptyPatch = (fields: Readonly<Record<string, unknown>>): string | null =>
  Object.values(fields).every((value) => value === undefined)
    ? `patch must set at least one of ${Object.keys(fields).join(', ')}`
    : null
