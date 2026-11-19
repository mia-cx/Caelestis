import { StaleArchiveOperationError } from '../archive/errors.js'
import {
  COUNTER_ARCHIVE_TABLES,
  type CounterArchiveTable,
  seedCounterTables,
} from './counter-tables.js'
import type { CoordinatorDatabase } from './database.js'

/** How far an archive operation's counter state has moved; it only ever moves forward. */
export const COUNTER_OPERATION = { importing: 0, cleaning: 1, closed: 2 } as const
type CounterOperationState = (typeof COUNTER_OPERATION)[keyof typeof COUNTER_OPERATION]

/** One keyset page of a coordinator table, for server archives. */
export const exportCounterRows = (
  database: CoordinatorDatabase,
  table: CounterArchiveTable,
  after: readonly (string | number)[] | null,
  limit: number,
): Promise<Record<string, string | number>[]> => {
  const { key } = COUNTER_ARCHIVE_TABLES[table]
  const columns = key.join(', ')
  return database.all<Record<string, string | number>>(
    `SELECT * FROM ${table}${after === null ? '' : ` WHERE (${columns}) > (${key.map(() => '?').join(', ')})`} ORDER BY ${columns} LIMIT ${Math.trunc(limit)}`,
    ...(after ?? []),
  )
}

/**
 * Advance `operationId`'s counter state. The row appears as importing for an operation that never
 * opened, so a discard or release of a restore that crashed before its first hold still closes.
 */
export const moveCounterOperation = async (
  database: CoordinatorDatabase,
  operationId: string,
  to: CounterOperationState,
): Promise<void> => {
  await database.run(
    'INSERT INTO counter_archive_operation (operation_id, state) VALUES (?1, ?2) ON CONFLICT DO NOTHING',
    operationId,
    COUNTER_OPERATION.importing,
  )
  await database.run(
    'UPDATE counter_archive_operation SET state = ?1 WHERE operation_id = ?2 AND state < ?1',
    to,
    operationId,
  )
}

/**
 * The fence every counter import or cleanup must move inside its own transaction: it really
 * modifies the operation's row (MariaDB reports no-op updates as zero rows), so contending
 * writers serialize on it and a revoked grant reports zero changes.
 */
const claimCounterState = async (
  database: CoordinatorDatabase,
  operationId: string,
  state: CounterOperationState,
): Promise<void> => {
  const claimed = await database.run(
    'UPDATE counter_archive_operation SET uses = uses + 1 WHERE operation_id = ?1 AND state = ?2',
    operationId,
    state,
  )
  if (claimed.rowsWritten !== 1) throw new StaleArchiveOperationError()
}

/** Restore archived rows over the seeded singletons. */
export const importCounterRows = (
  database: CoordinatorDatabase,
  operationId: string,
  table: CounterArchiveTable,
  rows: readonly Readonly<Record<string, string | number>>[],
): Promise<void> => {
  const { key, columns } = COUNTER_ARCHIVE_TABLES[table]
  const keyColumns: readonly string[] = key
  const updates = columns.filter((column) => !keyColumns.includes(column))
  return database.transaction(async (transaction) => {
    // Checked in the same transaction as the writes: once a discard or release moved this
    // operation's counter state forward, its late imports change nothing.
    await claimCounterState(transaction, operationId, COUNTER_OPERATION.importing)
    const held = await transaction.all(
      'SELECT 1 FROM counter_freeze WHERE operation_id = ?1',
      operationId,
    )
    if (held.length === 0) throw new StaleArchiveOperationError()
    for (const row of rows)
      await transaction.run(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `?${index + 1}`).join(', ')}) ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${updates.map((column) => `${column} = excluded.${column}`).join(', ')}`,
        ...columns.map((column) => row[column] ?? null),
      )
  })
}

/** Return to a new server's counter state after a discarded restore. */
export const discardCounterRows = async (
  database: CoordinatorDatabase,
  operationId: string,
): Promise<void> => {
  await database.transaction(async (transaction) => {
    // A stale discard cannot empty counters its operation already closed.
    await claimCounterState(transaction, operationId, COUNTER_OPERATION.cleaning)
    for (const table of Object.keys(COUNTER_ARCHIVE_TABLES))
      await transaction.run(`DELETE FROM ${table}`)
  })
  await seedCounterTables(database)
}
