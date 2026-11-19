import { readsPreviousChanges } from '../previous-changes.js'
import type { SqlDialectName, SqlResult, SqlStatement } from '../sql-connection.js'

/** One query's rows as arrays, their column names, and the number of rows it changed. */
export interface Executed {
  readonly rows: unknown[][]
  readonly columns: readonly string[]
  readonly changes: number
}

/** What a database driver supplies so `DriverStatement` and `runBatch` can run its SQL. */
export interface StatementDriver<Client> {
  readonly dialect: SqlDialectName
  /** Run `operation` on a client the driver chooses, in turn with its other callers. */
  withClient<T>(operation: (client: Client) => Promise<T>): Promise<T>
  execute(client: Client, query: string, values: readonly unknown[]): Promise<Executed>
  /** Store a count where the dialect's `PREVIOUS_CHANGED` condition reads it. */
  setPreviousChanges(client: Client, changes: number): Promise<void>
}

/** A bound query, run on its own client or, inside a transaction, on the transaction's client. */
export class DriverStatement<Client> implements SqlStatement {
  constructor(
    readonly driver: StatementDriver<Client>,
    readonly query: string,
    readonly values: readonly unknown[] = [],
    readonly client?: Client,
  ) {}

  bind(...values: unknown[]): DriverStatement<Client> {
    return new DriverStatement(this.driver, this.query, values, this.client)
  }

  on(client: Client): DriverStatement<Client> {
    return new DriverStatement(this.driver, this.query, this.values, client)
  }

  private execute(): Promise<Executed> {
    const { driver, query, values, client } = this
    return client === undefined
      ? driver.withClient((session) => driver.execute(session, query, values))
      : driver.execute(client, query, values)
  }

  async run<T>(): Promise<SqlResult<T>> {
    const { rows, columns, changes } = await this.execute()
    return {
      // Rows are shaped by the query's own columns; the caller names that shape as `T`.
      results: rows.map((row) =>
        Object.fromEntries(columns.map((column, index) => [column, row[index]])),
      ) as T[],
      meta: { changes },
    }
  }
  all<T>(): Promise<SqlResult<T>> {
    return this.run<T>()
  }
  async first<T>(): Promise<T | null> {
    return (await this.run<T>()).results[0] ?? null
  }
  async raw<T>(): Promise<T[]> {
    return (await this.execute()).rows as T[]
  }
}

/** Run a batch in order on a transaction's client, feeding each statement the previous count. */
export const runBatch = async <Client, T>(
  driver: StatementDriver<Client>,
  client: Client,
  statements: readonly SqlStatement[],
): Promise<SqlResult<T>[]> => {
  const results: SqlResult<T>[] = []
  for (const statement of statements) {
    if (!(statement instanceof DriverStatement) || statement.driver !== driver)
      throw new Error('Statement belongs to another connection')
    if (readsPreviousChanges(driver.dialect, statement.query))
      await driver.setPreviousChanges(client, results.at(-1)?.meta.changes ?? 0)
    results.push(await statement.on(client).run<T>())
  }
  return results
}
