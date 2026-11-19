import { uuidV7 } from '@caelestis/shared'
import type { SqlConnection, SqlStatement } from '../adapters/sql-connection.js'

/** The one `archive_operation` row: the durable record of the operation holding the server. */
export interface ArchiveOperationRow {
  readonly kind: 'export' | 'import'
  readonly operationId: string
  readonly startedAt: number
  readonly position: number
  readonly stateJson: string
}

/**
 * Matches the row only while it is exactly the one a caller read: every change moves the position
 * or the state, so this is the compare-and-set every lifecycle write is guarded by. Bind
 * `sameOperation(row)` for its placeholders.
 */
const SAME_OPERATION =
  '"archive_operation"."id" = 1 AND "archive_operation"."operation_id" = ? AND "archive_operation"."position" = ? AND "archive_operation"."state_json" = ?'
const sameOperation = (operation: ArchiveOperationRow) =>
  [operation.operationId, operation.position, operation.stateJson] as const

/** True in SQL while `operation` still holds the server unchanged; binds `sameOperation` values. */
export const operationHolds = (operation: ArchiveOperationRow) => ({
  sql: `EXISTS (SELECT 1 FROM "archive_operation" WHERE ${SAME_OPERATION})`,
  values: sameOperation(operation),
})

/** Replace exactly `from` with `stateJson` at `position`; changes nothing once `from` is stale. */
export const advanceOperation = (
  connection: SqlConnection,
  from: ArchiveOperationRow,
  stateJson: string,
  position: number,
): SqlStatement =>
  connection
    .prepare(
      `UPDATE "archive_operation" SET "state_json" = ?, "position" = ? WHERE ${SAME_OPERATION}`,
    )
    .bind(stateJson, position, ...sameOperation(from))

/** Delete exactly `operation`'s row, which opens the server; a stale caller deletes nothing. */
export const deleteOperation = (
  connection: SqlConnection,
  operation: ArchiveOperationRow,
): SqlStatement =>
  connection
    .prepare(`DELETE FROM "archive_operation" WHERE ${SAME_OPERATION}`)
    .bind(...sameOperation(operation))

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
         FROM "archive_operation", "archive_lease" AS lease
         WHERE ${SAME_OPERATION}
           AND lease."id" = 1
           AND lease."holder" = ?
           AND lease."fence" = ?
       )`,
    )
    .bind(...sameOperation(operation), lease.holder, lease.fence)
