export type SqlDialectName = 'sqlite' | 'postgres' | 'mariadb'

export interface SqlResult<T = Record<string, unknown>> {
  readonly results: T[]
  readonly meta: { readonly changes: number }
}

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>
  first<T = Record<string, unknown>>(): Promise<T | null>
  raw<T = unknown[]>(): Promise<T[]>
}

/** The SQL the relational stores run. Batches commit atomically, in order. */
export interface SqlConnection {
  readonly dialect: SqlDialectName
  prepare(query: string): SqlStatement
  batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]>
}

/** Callback operations use the supplied connection and commit or roll back together. */
export interface TransactionalSqlConnection extends SqlConnection {
  transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T>
}
