import { type AnyColumn, sql } from 'drizzle-orm'
import { PREVIOUS_CHANGED } from './previous-changes.js'
import type { SqlDialectName } from './sql-connection.js'

/** The few expressions that differ between SQLite/D1, PostgreSQL, and MariaDB. */
export const sqlDialect = (dialect: SqlDialectName) => {
  const postgres = dialect === 'postgres'
  const maria = dialect === 'mariadb'
  return {
    nullEqual: maria ? '<=>' : postgres ? 'IS NOT DISTINCT FROM' : 'IS',
    greatest: postgres || maria ? 'greatest' : 'max',
    jsonEach: maria
      ? "JSON_TABLE(?, '$[*]' COLUMNS (value JSON PATH '$')) AS json_values"
      : postgres
        ? 'jsonb_array_elements(?::jsonb)'
        : 'json_each(?)',
    previousChanged: PREVIOUS_CHANGED[dialect],
    jsonField: (field: string, type: 'text' | 'bigint' | 'json' = 'bigint') => {
      if (maria) {
        const value = `JSON_EXTRACT(value, '$.${field}')`
        if (type === 'json') return `${value} COLLATE utf8mb4_nopad_bin`
        const unquoted = `IF(JSON_TYPE(${value}) = 'NULL', NULL, JSON_UNQUOTE(${value}))`
        return type === 'text'
          ? `${unquoted} COLLATE utf8mb4_nopad_bin`
          : `CAST(${unquoted} AS SIGNED)`
      }
      if (!postgres) return `json_extract(value, '$.${field}')`
      if (type === 'json') return `(value -> '${field}')::text`
      return `(value ->> '${field}')::${type}`
    },
    jsonAggregate: (column: AnyColumn) =>
      maria
        ? sql<string>`json_arrayagg(${column})`
        : postgres
          ? sql<string>`json_agg(${column})::text`
          : sql<string>`json_group_array(${column})`,
  }
}
