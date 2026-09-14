import { Database } from 'bun:sqlite'
import type { SqliteDatabase, SqliteValue } from '../adapters/database-driver.js'

const value = (input: unknown): unknown => {
  if (typeof input !== 'bigint') return input
  const number = Number(input)
  if (!Number.isSafeInteger(number)) throw new RangeError('Database integer exceeds the wire range')
  return number
}

/** Native SQLite statements retain the shared adapter's migrations and transaction serialization. */
export const bunSqliteDatabase = (filename: string): SqliteDatabase => {
  const database = new Database(filename, { create: true, strict: true, safeIntegers: true })
  const row = (input: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, value(entry)]))
  return {
    exec: (query) => {
      database.exec(query)
    },
    close: () => database.close(),
    prepare(query) {
      const statement = database.query<Record<string, unknown>, SqliteValue[]>(query)
      return {
        columns: () => statement.columnNames,
        all: (...values) => statement.all(...values).map(row),
        get(...values) {
          const result = statement.get(...values)
          return result === null ? undefined : row(result)
        },
        run: (...values) => statement.run(...values),
        raw: (...values) => statement.values(...values).map((entries) => entries.map(value)),
      }
    },
  }
}
