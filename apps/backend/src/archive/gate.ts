import type { SqlConnection, SqlResult, SqlStatement } from '../adapters/sql-connection.js'

/** How long one store trusts its last gate read before reading it again. */
export const ARCHIVE_GATE_CACHE_MILLISECONDS = 1_000

/**
 * How long a restore waits after closing the gate before it accepts records. Writes never rely
 * on this: they fail inside their own transaction. It only lets other Worker isolates' cached
 * gate reads expire, so no request reads a partly restored dataset.
 */
export const ARCHIVE_SETTLE_MILLISECONDS = 2_000

export interface ArchiveOperationRow {
  readonly kind: 'export' | 'import'
  readonly operationId: string
  readonly startedAt: number
  readonly position: number
  readonly stateJson: string
}

/** A write reached a store while an archive operation held the server. */
export class ArchiveOperationActiveError extends Error {
  constructor(options?: ErrorOptions) {
    super('A server archive operation is in progress; writes resume when it ends', options)
  }
}

/** Archive work arrived for an operation that no longer holds the server. */
export class StaleArchiveOperationError extends Error {
  constructor() {
    super('This archive operation no longer holds the server')
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

/**
 * Writes in flight through one database connection in this process. Portable runtimes have one
 * process, so closing this and draining it is a complete barrier there. Worker isolates rely on
 * the guard statement instead: a D1 batch either commits before the gate row or fails.
 */
interface ProcessWrites {
  /** Operations holding writes closed. Each releases only its own hold. */
  readonly closedBy: Set<string>
  readonly inFlight: Set<Promise<unknown>>
}
const processWrites = new WeakMap<SqlConnection, ProcessWrites>()
const writesThrough = (connection: SqlConnection): ProcessWrites => {
  const existing = processWrites.get(connection)
  if (existing !== undefined) return existing
  const created: ProcessWrites = { closedBy: new Set(), inFlight: new Set() }
  processWrites.set(connection, created)
  return created
}

/** Refuse new writes through `connection` at once, then wait for every admitted write to end. */
export const closeProcessWrites = async (
  connection: SqlConnection,
  operationId: string,
): Promise<void> => {
  const writes = writesThrough(connection)
  writes.closedBy.add(operationId)
  await Promise.allSettled([...writes.inFlight])
}

/** Drop `operationId`'s hold; writes reopen once no operation holds them. */
export const openProcessWrites = (connection: SqlConnection, operationId: string): void => {
  writesThrough(connection).closedBy.delete(operationId)
}

/** A briefly cached answer to "is an archive operation holding this server?". */
export const archiveGate = (connection: SqlConnection) => {
  let cached: { readonly active: boolean; readonly until: number } | undefined
  return async (options: { readonly fresh?: boolean } = {}): Promise<boolean> => {
    if (writesThrough(connection).closedBy.size > 0) return true
    const at = Date.now()
    if (!options.fresh && cached !== undefined && cached.until > at) return cached.active
    const active = (await readArchiveOperation(connection)) !== null
    cached = { active, until: at + ARCHIVE_GATE_CACHE_MILLISECONDS }
    return active
  }
}

/**
 * Fails while the gate row exists: moving the row off id 1 breaks its CHECK constraint. With no
 * row it changes nothing. It runs first in the writer's own transaction, so the decision and the
 * write commit together.
 */
const GUARD = 'UPDATE "archive_operation" SET "id" = 0 WHERE "id" = 1'

const MUTATION = /^\s*(?:insert|update|delete|replace)\b/i
const mutates = (query: string): boolean =>
  MUTATION.test(query) || (/^\s*with\b/i.test(query) && /\b(?:insert|update|delete)\b/i.test(query))

interface Fence {
  /** Run one admitted write, tracked until it settles. */
  readonly admit: <T>(write: () => Promise<T>) => Promise<T>
  /** Run statements as one batch led by the guard; null when the process gate decides alone. */
  readonly guard: (<T>(statements: SqlStatement[]) => Promise<SqlResult<T>[]>) | null
}

class FencedStatement implements SqlStatement {
  constructor(
    readonly inner: SqlStatement,
    readonly mutation: boolean,
    private readonly fence: Fence,
  ) {}
  bind(...values: unknown[]): SqlStatement {
    return new FencedStatement(this.inner.bind(...values), this.mutation, this.fence)
  }
  private write<A>(direct: () => Promise<A>, fromBatch: (result: SqlResult) => A): Promise<A> {
    if (!this.mutation) return direct()
    const { guard } = this.fence
    return this.fence.admit(async () =>
      guard === null ? direct() : fromBatch((await guard([this.inner])).at(-1) as SqlResult),
    )
  }
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.write(
      () => this.inner.run<T>(),
      (result) => result as SqlResult<T>,
    )
  }
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.write(
      () => this.inner.all<T>(),
      (result) => result as SqlResult<T>,
    )
  }
  first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.write(
      () => this.inner.first<T>(),
      (result) => (result.results[0] as T | undefined) ?? null,
    )
  }
  raw<T = unknown[]>(): Promise<T[]> {
    return this.write(
      () => this.inner.raw<T>(),
      (result) => result.results.map((row) => Object.values(row as object) as T),
    )
  }
}

/**
 * Refuse every mutating statement while an archive operation holds the server, whichever caller
 * issued it: HTTP routes, live sockets, alarms, and scheduled jobs all write through this.
 *
 * Portable connections run in one process, so the process gate and its drain decide; their
 * transactions also serialize in-process callers, which a guard batch would deadlock. D1 has many
 * isolates and no transactions, so every write there becomes one batch led by the guard.
 */
export const fencedConnection = (connection: SqlConnection): SqlConnection => {
  const writes = writesThrough(connection)
  const fence: Fence = {
    async admit(write) {
      if (writes.closedBy.size > 0) throw new ArchiveOperationActiveError()
      const running = write()
      writes.inFlight.add(running)
      try {
        return await running
      } finally {
        writes.inFlight.delete(running)
      }
    },
    guard:
      'transaction' in connection
        ? null
        : async <T>(statements: SqlStatement[]) => {
            try {
              return (await connection.batch<T>([connection.prepare(GUARD), ...statements])).slice(
                1,
              )
            } catch (cause) {
              if ((await readArchiveOperation(connection)) !== null)
                throw new ArchiveOperationActiveError({ cause })
              throw cause
            }
          },
  }
  const unwrap = (statement: SqlStatement): SqlStatement =>
    statement instanceof FencedStatement ? statement.inner : statement
  return {
    ...(connection.dialect === undefined ? {} : { dialect: connection.dialect }),
    prepare: (query) => new FencedStatement(connection.prepare(query), mutates(query), fence),
    batch<T = unknown>(statements: SqlStatement[]) {
      const inner = statements.map(unwrap)
      if (
        !statements.some((statement) => statement instanceof FencedStatement && statement.mutation)
      )
        return connection.batch<T>(inner)
      const { guard } = fence
      return fence.admit(() => (guard === null ? connection.batch<T>(inner) : guard<T>(inner)))
    },
  }
}
