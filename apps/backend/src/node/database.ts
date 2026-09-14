import type { SqliteDatabase } from '../adapters/database-driver.js'
import { SqliteConnection } from '../adapters/node/sqlite-connection.js'

const bun: { bunSqliteDatabase(filename: string): SqliteDatabase } | undefined = process.versions
  .bun
  ? await import(new URL('../bun/sqlite-driver.js', import.meta.url).href)
  : undefined

/** Select only the SQLite binding; file format, migrations, and transactions stay canonical. */
export const sqliteConnection = (filename: string): SqliteConnection =>
  new SqliteConnection(filename, bun?.bunSqliteDatabase(filename))
