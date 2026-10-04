import type { SqlConnection, SqlResult, SqlStatement } from '../adapters/sql-connection.js'

/** How long one store trusts its last gate read. Archive operations wait out more than this. */
export const ARCHIVE_GATE_CACHE_MILLISECONDS = 1_000

/**
 * How long an operation waits after closing the gate before it reads or writes data. It covers
 * every cached gate read plus one in-flight statement, which the databases cap at 30 seconds.
 */
export const ARCHIVE_SETTLE_MILLISECONDS = 35_000

export interface ArchiveOperationRow {
  readonly kind: 'export' | 'import'
  readonly operationId: string
  readonly startedAt: number
  readonly position: number
  readonly stateJson: string
}

/** A write reached a store while an archive operation held the server. */
export class ArchiveOperationActiveError extends Error {
  constructor() {
    super('A server archive operation is in progress; writes resume when it ends')
  }
}

export const readArchiveOperation = async (
  connection: SqlConnection,
): Promise<ArchiveOperationRow | null> => {
  const row = await connection
    .prepare(
      'SELECT "kind", "operation_id", "started_at_ms", "position", "state_json" FROM "archive_operation" WHERE "id" = 1',
    )
    .first<{
      kind: 'export' | 'import'
      operation_id: string
      started_at_ms: number
      position: number
      state_json: string
    }>()
  return row === null
    ? null
    : {
        kind: row.kind,
        operationId: row.operation_id,
        startedAt: Number(row.started_at_ms),
        position: Number(row.position),
        stateJson: row.state_json,
      }
}

/** A briefly cached answer to "is an archive operation holding this server?". */
export const archiveGate = (connection: SqlConnection, now = () => Date.now()) => {
  let cached: { readonly active: boolean; readonly until: number } | undefined
  return async (): Promise<boolean> => {
    const at = now()
    if (cached !== undefined && cached.until > at) return cached.active
    const active = (await readArchiveOperation(connection)) !== null
    cached = { active, until: at + ARCHIVE_GATE_CACHE_MILLISECONDS }
    return active
  }
}

const MUTATION = /^\s*(?:insert|update|delete|replace)\b/i
const mutates = (query: string): boolean =>
  MUTATION.test(query) || (/^\s*with\b/i.test(query) && /\b(?:insert|update|delete)\b/i.test(query))

class FencedStatement implements SqlStatement {
  constructor(
    readonly inner: SqlStatement,
    readonly mutation: boolean,
    private readonly assertOpen: () => Promise<void>,
  ) {}
  bind(...values: unknown[]): SqlStatement {
    return new FencedStatement(this.inner.bind(...values), this.mutation, this.assertOpen)
  }
  private async guarded<T>(run: () => Promise<T>): Promise<T> {
    if (this.mutation) await this.assertOpen()
    return run()
  }
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.guarded(() => this.inner.run<T>())
  }
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.guarded(() => this.inner.all<T>())
  }
  first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.guarded(() => this.inner.first<T>())
  }
  raw<T = unknown[]>(): Promise<T[]> {
    return this.guarded(() => this.inner.raw<T>())
  }
}

/**
 * Refuse every mutating statement while an archive operation holds the server, whichever caller
 * issued it: HTTP routes, live sockets, alarms, and scheduled jobs all write through this.
 */
export const fencedConnection = (
  connection: SqlConnection,
  active: () => Promise<boolean>,
): SqlConnection => {
  const assertOpen = async () => {
    if (await active()) throw new ArchiveOperationActiveError()
  }
  const unwrap = (statement: SqlStatement): SqlStatement =>
    statement instanceof FencedStatement ? statement.inner : statement
  return {
    ...(connection.dialect === undefined ? {} : { dialect: connection.dialect }),
    prepare: (query) => new FencedStatement(connection.prepare(query), mutates(query), assertOpen),
    async batch<T = unknown>(statements: SqlStatement[]) {
      if (
        statements.some((statement) => statement instanceof FencedStatement && statement.mutation)
      )
        await assertOpen()
      return connection.batch<T>(statements.map(unwrap))
    },
  }
}
