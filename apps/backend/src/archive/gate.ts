import { uuidV7 } from '@caelestis/shared'
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

/** How long one archive request may hold the lease before another may take it over. */
export const ARCHIVE_LEASE_TTL_MILLISECONDS = 120_000
/** A call stops writing to outside stores this long before its lease would expire. */
export const ARCHIVE_LEASE_MARGIN_MILLISECONDS = 15_000

/**
 * The lease one archive request holds. `fence` goes up on every take-over, so a stalled caller's
 * guarded writes can always be told from the current holder's.
 */
export interface ArchiveLease {
  readonly holder: string
  readonly fence: number
  readonly expiresAt: number
  /** External writes and deletions must stop at `expiresAt` minus the margin. */
  readonly deadline: number
}

/**
 * Take the archive lease for one request, or null when a live request holds it. The fence is
 * read back under the unique holder id, so a take-over can never borrow another holder's fence.
 */
export const acquireArchiveLease = async (
  connection: SqlConnection,
  now = Date.now(),
): Promise<ArchiveLease | null> => {
  const holder = uuidV7()
  const expiresAt = now + ARCHIVE_LEASE_TTL_MILLISECONDS
  const taken = await connection
    .prepare(
      'UPDATE "archive_lease" SET "holder" = ?, "fence" = "fence" + 1, "expires_at_ms" = ? WHERE "id" = 1 AND ("holder" IS NULL OR "expires_at_ms" < ?)',
    )
    .bind(holder, expiresAt, now)
    .run()
  if (taken.meta.changes !== 1) return null
  const row = await connection
    .prepare('SELECT "fence" FROM "archive_lease" WHERE "id" = 1 AND "holder" = ?')
    .bind(holder)
    .first<{ fence: number }>()
  if (row === null) return null
  return {
    holder,
    fence: Number(row.fence),
    expiresAt,
    deadline: expiresAt - ARCHIVE_LEASE_MARGIN_MILLISECONDS,
  }
}

/** Give the lease back; only the same holder and fence can, so a take-over stays taken. */
export const releaseArchiveLease = async (
  connection: SqlConnection,
  lease: ArchiveLease,
): Promise<void> => {
  await connection
    .prepare(
      'UPDATE "archive_lease" SET "holder" = NULL WHERE "id" = 1 AND "holder" = ? AND "fence" = ?',
    )
    .bind(lease.holder, lease.fence)
    .run()
}

/**
 * A batch statement that commits nothing unless the operation row still carries exactly
 * `operation`'s state and `lease` is still this call's. It inserts a row that violates the
 * table's CHECK constraints precisely when either check fails — a missing row, a moved-on state,
 * or a taken-over lease all abort the batch. When both hold it inserts nothing.
 */
export const archiveFence = (
  connection: SqlConnection,
  operation: ArchiveOperationRow,
  lease: ArchiveLease,
): SqlStatement =>
  connection
    .prepare(
      `INSERT INTO "archive_operation" ("id", "kind", "operation_id", "started_at_ms", "position", "state_json")
       SELECT 0, '', '', 0, 0, ''
       WHERE NOT EXISTS (
         SELECT 1
         FROM "archive_operation" AS operation, "archive_lease" AS lease
         WHERE operation."id" = 1
           AND operation."operation_id" = ?
           AND operation."position" = ?
           AND operation."state_json" = ?
           AND lease."id" = 1
           AND lease."holder" = ?
           AND lease."fence" = ?
       )`,
    )
    .bind(operation.operationId, operation.position, operation.stateJson, lease.holder, lease.fence)

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
