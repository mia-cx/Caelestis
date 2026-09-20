import { RelationalSqlStore } from '../relational-sql-store.js'

/** Adapt Cloudflare's transactional D1 binding to the shared relational store. */
export class D1SqlStore extends RelationalSqlStore {
  // biome-ignore lint/complexity/noUselessConstructor: this adapter narrows SqlConnection to the Cloudflare D1 binding.
  constructor(database: D1Database) {
    super(database)
  }
}
