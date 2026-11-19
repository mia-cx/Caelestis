import type { SqlConnection } from '../sql-connection.js'

/** D1 as the stores' connection: SQLite, with batches as its only atomic unit. */
export const d1Connection = (database: D1Database): SqlConnection => ({
  dialect: 'sqlite',
  prepare: (query) => database.prepare(query),
  batch: database.batch.bind(database),
})
