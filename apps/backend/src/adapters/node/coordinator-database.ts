import type { CoordinatorDatabase } from '../../coordination/database.js'
import type { SqlConnection, TransactionalSqlConnection } from '../sql-connection.js'

/** The coordinator tables over `connection`; `root` opens transactions, or null inside one. */
const scoped = (
  root: TransactionalSqlConnection | null,
  connection: SqlConnection,
): CoordinatorDatabase => ({
  dialect: connection.dialect ?? 'sqlite',
  async all<T>(query: string, ...values: (string | number | null)[]) {
    return (
      await connection
        .prepare(query)
        .bind(...values)
        .all<T>()
    ).results
  },
  async one<T>(query: string, ...values: (string | number | null)[]) {
    const result = await connection
      .prepare(query)
      .bind(...values)
      .first<T>()
    if (result === null) throw new Error('Expected one coordinator row')
    return result
  },
  async run(query, ...values) {
    return {
      rowsWritten: (
        await connection
          .prepare(query)
          .bind(...values)
          .run()
      ).meta.changes,
    }
  },
  transaction: (operation) =>
    root === null
      ? operation(scoped(null, connection))
      : root.transaction((transaction) => operation(scoped(null, transaction))),
})

/** Coordinator tables in the application database, for hosts without Durable Object storage. */
export const coordinatorDatabase = (root: TransactionalSqlConnection): CoordinatorDatabase =>
  scoped(root, root)

/** The coordinator tables inside a transaction the caller already holds. */
export const coordinatorTransaction = (transaction: SqlConnection): CoordinatorDatabase =>
  scoped(null, transaction)
