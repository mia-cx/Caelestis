import type { SqlDialectName } from './sql-connection.js'

const POSTGRES_SETTING = 'caelestis.changed_rows'
const MARIADB_VARIABLE = '@caelestis_changed_rows'

/**
 * A batch statement's condition "the previous statement changed a row". SQLite answers it with
 * `changes()`. PostgreSQL and MariaDB have no equivalent, so their connections store the previous
 * statement's count in a session variable before running a statement that reads it.
 */
export const PREVIOUS_CHANGED: Readonly<Record<SqlDialectName, string>> = {
  sqlite: 'changes() > 0',
  postgres: `current_setting('${POSTGRES_SETTING}')::bigint > 0`,
  mariadb: `${MARIADB_VARIABLE} > 0`,
}

/** The driver-native statement that stores the previous count, its one parameter, per dialect. */
export const SET_PREVIOUS_CHANGES = {
  postgres: `SELECT set_config('${POSTGRES_SETTING}', $1, true)`,
  mariadb: `SET ${MARIADB_VARIABLE} = ?`,
} as const

export const readsPreviousChanges = (dialect: SqlDialectName, query: string): boolean =>
  query.includes(PREVIOUS_CHANGED[dialect])
