import { SqliteConnection } from '../adapters/node/sqlite-connection.js'
import { bun } from './bun.js'

/** Select only the SQLite binding; file format, migrations, and transactions stay canonical. */
export const sqliteConnection = (filename: string): SqliteConnection =>
  new SqliteConnection(filename, bun?.bunSqliteDatabase(filename))
