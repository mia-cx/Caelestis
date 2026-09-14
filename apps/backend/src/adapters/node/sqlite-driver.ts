import { DatabaseSync } from 'node:sqlite'
import type { SqliteDatabase } from '../database-driver.js'

/** Node's SQLite binding implements the shared synchronous database driver. */
export const nodeSqliteDatabase = (filename: string): SqliteDatabase => {
  const database = new DatabaseSync(filename)
  return {
    exec: (query) => database.exec(query),
    close: () => database.close(),
    prepare(query) {
      const statement = database.prepare(query)
      return {
        columns: () => statement.columns(),
        all: (...values) => statement.all(...values),
        get: (...values) => statement.get(...values),
        run: (...values) => statement.run(...values),
        raw(...values) {
          statement.setReturnArrays(true)
          try {
            return statement.all(...values)
          } finally {
            statement.setReturnArrays(false)
          }
        },
      }
    },
  }
}
