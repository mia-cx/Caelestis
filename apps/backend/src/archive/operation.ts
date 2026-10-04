import { uuidV7 } from '@caelestis/shared'
import { ArchiveError } from './format.js'
import {
  ARCHIVE_SETTLE_MILLISECONDS,
  closeProcessWrites,
  openProcessWrites,
  readArchiveOperation,
} from './gate.js'
import type { ArchiveHost } from './port.js'

/**
 * Close the gate and wait until nothing else can change the dataset. The gate row makes every
 * relational write fail inside its own transaction; this process's admitted writes and counter
 * records then drain. Only after that does the caller read or check data.
 */
export const holdServer = async (
  host: ArchiveHost,
  kind: 'export' | 'import',
  state: string,
  position: number,
) => {
  const startedAt = Date.now()
  const operationId = uuidV7()
  try {
    await host.connection
      .prepare(
        'INSERT INTO "archive_operation" ("id", "kind", "operation_id", "started_at_ms", "position", "state_json") VALUES (1, ?, ?, ?, ?, ?)',
      )
      .bind(kind, operationId, startedAt, position, state)
      .run()
  } catch (cause) {
    if ((await readArchiveOperation(host.connection)) !== null)
      throw new ArchiveError('Another archive operation is in progress.', 409)
    throw cause
  }
  try {
    await closeProcessWrites(host.connection)
    await host.counters.freeze()
  } catch (error) {
    await releaseServer(host, operationId)
    throw error
  }
  return { operationId, startedAt }
}

/**
 * Reopen the server if `operationId` still holds it and, when given, its state is unchanged.
 * Returns false when another request changed the operation first.
 */
export const releaseServer = async (
  host: ArchiveHost,
  operationId: string,
  expectedState?: string,
): Promise<boolean> => {
  const released = await host.connection
    .prepare(
      `DELETE FROM "archive_operation" WHERE "id" = 1 AND "operation_id" = ?${expectedState === undefined ? '' : ' AND "state_json" = ?'}`,
    )
    .bind(operationId, ...(expectedState === undefined ? [] : [expectedState]))
    .run()
  if (released.meta.changes === 0) return false
  openProcessWrites(host.connection)
  await host.counters.thaw()
  return true
}

/** When a restore may accept records: other isolates' cached gate reads have expired. */
export const archiveReadyAt = (host: ArchiveHost, startedAt: number): number =>
  startedAt + (host.settleMilliseconds ?? ARCHIVE_SETTLE_MILLISECONDS)

export const assertSettled = (host: ArchiveHost, startedAt: number): void => {
  const readyAt = archiveReadyAt(host, startedAt)
  if (Date.now() < readyAt)
    throw new ArchiveError('Cached gate reads are still expiring. Retry shortly.', 409, readyAt)
}
