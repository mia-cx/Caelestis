import { type TemplateSurface, templateSurface } from '@caelestis/shared'
import { type AnyColumn, and, eq, isNull, type SQL } from 'drizzle-orm'

/** A table whose rows each live in one season of one drawing surface. */
interface ScopedTable {
  readonly season: AnyColumn
  readonly surfaceKind: AnyColumn
  readonly allianceId: AnyColumn
}

/** `table`'s rows in `season` on `surface`. */
export const scopeWhere = (table: ScopedTable, season: number, surface: TemplateSurface): SQL =>
  and(
    eq(table.season, season),
    eq(table.surfaceKind, surface.kind),
    surface.allianceId === null
      ? isNull(table.allianceId)
      : eq(table.allianceId, surface.allianceId),
  ) as SQL

/**
 * The raw-SQL form of `scopeWhere`: `alias` names the table, `nullEqual` is the dialect's
 * null-safe equality. Bind `scopeBindings` in the same position.
 */
export const scopeCondition = (alias: string, nullEqual: string): string =>
  `${alias}.season = ? AND ${alias}.surface_kind = ? AND ${alias}.alliance_id ${nullEqual} ?`

export const scopeBindings = (season: number, surface: TemplateSurface) =>
  [season, surface.kind, surface.allianceId] as const

/** The surface a stored row names. The surface CHECK admits no other, so a miss is corruption. */
export const surfaceOf = (
  row: { readonly surfaceKind: string; readonly allianceId: number | null },
  label: string,
): TemplateSurface => {
  const surface = templateSurface(row.surfaceKind, row.allianceId)
  if (surface === null) throw new Error(`${label} has an invalid surface`)
  return surface
}
