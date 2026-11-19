import { TEMPLATE_SURFACE_KINDS, WORLD_TILES } from '@caelestis/shared'
import { type AnyColumn, sql } from 'drizzle-orm'

/*
 * CHECK clauses several tables share. The text is what drizzle-kit records in each migration
 * snapshot, line breaks and indentation included, so a change here is a schema change.
 */

/** `column` holds a lowercase sha256 hex digest. */
export const sha256Hex = (column: AnyColumn) =>
  sql`typeof(${column}) = 'text' AND length(${column}) = 64
        AND ${column} NOT GLOB '*[^0-9a-f]*'`

/** An integer tile coordinate pair from `min` up to the world's last tile on both axes. */
export const tileCoordinate = (x: AnyColumn, y: AnyColumn, min = 0) => {
  const range = sql.raw(`BETWEEN ${min} AND ${WORLD_TILES - 1}`)
  return sql`typeof(${x}) = 'integer' AND typeof(${y}) = 'integer'
        AND ${x} ${range}
        AND ${y} ${range}`
}

const ALLIANCE_SURFACE_KINDS = sql.raw(
  TEMPLATE_SURFACE_KINDS.filter((kind) => kind !== 'world')
    .map((kind) => `'${kind}'`)
    .join(', '),
)

/** The world carries no alliance; every alliance surface carries a positive one. */
export const surfaceCheck = (kind: AnyColumn, allianceId: AnyColumn) =>
  sql`(${kind} = 'world' AND ${allianceId} IS NULL)
        OR (${kind} IN (${ALLIANCE_SURFACE_KINDS})
          AND typeof(${allianceId}) = 'integer' AND ${allianceId} > 0)`
