import { relationalDatabase } from './relational-database.js'
import type { SqlConnection } from './sql-connection.js'
import { sqlDialect } from './sql-dialect.js'

/**
 * What every relational feature store is built on: one connection, already fenced by the archive
 * gate, with a drizzle builder and the dialect's few differing expressions over it.
 */
export abstract class RelationalStore {
  protected readonly database: ReturnType<typeof relationalDatabase>
  protected readonly syntax: ReturnType<typeof sqlDialect>

  constructor(protected readonly client: SqlConnection) {
    this.database = relationalDatabase(client)
    this.syntax = sqlDialect(client.dialect)
  }
}
