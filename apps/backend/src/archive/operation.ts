import { uuidV7 } from '@caelestis/shared'
import { ArchiveError } from './format.js'
import {
  ARCHIVE_SETTLE_MILLISECONDS,
  type ArchiveOperationRow,
  closeProcessWrites,
  openProcessWrites,
  readArchiveOperation,
} from './gate.js'
import type { ArchiveHost } from './port.js'

/**
 * The archive operation lifecycle. The `archive_operation` row is the only durable record, and
 * its `state_json` carries the phase:
 *
 *   export:  freezing → frozen → releasing → (row deleted)
 *   import:  preparing → ready → releasing → (row deleted)
 *            preparing → releasing            (refused or cancelled before anything was restored)
 *            ready → discarding → releasing   (discard; ready includes the ended archive)
 *
 * One rule makes every transition safe against crashes and concurrent calls:
 *
 * 1. Every transition is a compare-and-set on the whole prior row: operation id, position, and
 *    state. A caller whose read went stale changes nothing and gets 409.
 * 2. Work inside a phase is idempotent, so whoever finds a row in that phase may run it again:
 *    freezing re-freezes, preparing re-checks, releasing re-thaws. A side effect that cannot join
 *    the compare-and-set is verified against the row afterwards and undone if the row moved on
 *    (`holdFor`), and every write into stores outside the database carries the token that the
 *    current phase holds, so a stale caller's write is refused.
 * 3. Writes reopen last. Releasing clears the counter freeze, then deletes the row, then opens
 *    the process gate. A failure leaves the row in `releasing`, still holding the server, and the
 *    next lifecycle call finishes it. Freezes and process gates are keyed by operation id, so a
 *    late release can never thaw a newer operation.
 */
export type ArchivePhase =
  | 'freezing'
  | 'frozen'
  | 'preparing'
  | 'ready'
  | 'discarding'
  | 'releasing'

export const phaseOf = (operation: ArchiveOperationRow): ArchivePhase =>
  (JSON.parse(operation.stateJson) as { phase: ArchivePhase }).phase

/** Replace exactly `from` with `state`; null when another request changed the operation first. */
export const transition = async <State extends { readonly phase: ArchivePhase }>(
  host: ArchiveHost,
  from: ArchiveOperationRow,
  state: State,
  position = from.position,
): Promise<ArchiveOperationRow | null> => {
  const stateJson = JSON.stringify(state)
  const changed = await host.connection
    .prepare(
      'UPDATE "archive_operation" SET "state_json" = ?, "position" = ? WHERE "id" = 1 AND "operation_id" = ? AND "position" = ? AND "state_json" = ?',
    )
    .bind(stateJson, position, from.operationId, from.position, from.stateJson)
    .run()
  return changed.meta.changes === 1 ? { ...from, stateJson, position } : null
}

export const changedError = () =>
  new ArchiveError('Another request changed this archive operation. Check its status.', 409)

/** The counter token a discard holds instead, so a stale append can no longer write counters. */
export const discardToken = (operationId: string) => `${operationId}/discard`

const HOLDING: ReadonlySet<ArchivePhase> = new Set([
  'freezing',
  'frozen',
  'preparing',
  'ready',
  'discarding',
])

/**
 * Stop every writer for `operation`, then prove it still holds the server. A freeze is a side
 * effect that cannot join the row's compare-and-set, so it is checked afterwards and undone when
 * it lost: a stale or delayed resume never leaves a freeze behind. Repeating it is harmless.
 */
export const holdFor = async (
  host: ArchiveHost,
  operation: ArchiveOperationRow,
  token = operation.operationId,
): Promise<void> => {
  await closeProcessWrites(host.connection, operation.operationId)
  await host.counters.freeze(token)
  const current = await readArchiveOperation(host.connection)
  const ours = current?.operationId === operation.operationId
  if (ours && current !== null && HOLDING.has(phaseOf(current))) return
  await host.counters.thaw(token)
  // A release of this operation still in progress reopens writes itself, after its delete.
  if (!ours) openProcessWrites(host.connection, operation.operationId)
  throw changedError()
}

/**
 * Create the operation row, which closes the gate, then wait until nothing else can change the
 * dataset. A crash leaves the row in its first phase; the caller's retry resumes it.
 */
export const holdServer = async (
  host: ArchiveHost,
  kind: 'export' | 'import',
  state: { readonly phase: ArchivePhase },
) => {
  await finishPendingRelease(host)
  const operation: ArchiveOperationRow = {
    kind,
    operationId: uuidV7(),
    startedAt: Date.now(),
    position: kind === 'export' ? 0 : 1,
    stateJson: JSON.stringify(state),
  }
  try {
    await host.connection
      .prepare(
        'INSERT INTO "archive_operation" ("id", "kind", "operation_id", "started_at_ms", "position", "state_json") VALUES (1, ?, ?, ?, ?, ?)',
      )
      .bind(
        kind,
        operation.operationId,
        operation.startedAt,
        operation.position,
        operation.stateJson,
      )
      .run()
  } catch (cause) {
    if ((await readArchiveOperation(host.connection)) !== null)
      throw new ArchiveError('Another archive operation is in progress.', 409)
    throw cause
  }
  await holdFor(host, operation)
  return operation
}

/**
 * Move `operation` to releasing, then release it. Returns false when another request changed the
 * operation first; the caller reports that instead of reopening anything.
 */
export const releaseServer = async (
  host: ArchiveHost,
  operation: ArchiveOperationRow,
): Promise<boolean> => {
  const releasing =
    phaseOf(operation) === 'releasing'
      ? operation
      : await transition(host, operation, {
          ...(JSON.parse(operation.stateJson) as object),
          phase: 'releasing',
        })
  if (releasing === null) return false
  await completeRelease(host, releasing)
  return true
}

/** Thaw, delete the row, then reopen this process's writes. Each step is safe to repeat. */
const completeRelease = async (host: ArchiveHost, operation: ArchiveOperationRow) => {
  await host.counters.thaw(operation.operationId)
  await host.counters.thaw(discardToken(operation.operationId))
  const deleted = await host.connection
    .prepare(
      'DELETE FROM "archive_operation" WHERE "id" = 1 AND "operation_id" = ? AND "state_json" = ?',
    )
    .bind(operation.operationId, operation.stateJson)
    .run()
  if (deleted.meta.changes === 1) openProcessWrites(host.connection, operation.operationId)
}

/** Finish a release a crash interrupted, so the next operation starts from an open server. */
export const finishPendingRelease = async (
  host: ArchiveHost,
): Promise<ArchiveOperationRow | null> => {
  const operation = await readArchiveOperation(host.connection)
  if (operation === null || phaseOf(operation) !== 'releasing') return operation
  await completeRelease(host, operation)
  return readArchiveOperation(host.connection)
}

/** When a restore may accept records: other isolates' cached gate reads have expired. */
export const archiveReadyAt = (host: ArchiveHost, startedAt: number): number =>
  startedAt + (host.settleMilliseconds ?? ARCHIVE_SETTLE_MILLISECONDS)

export const assertSettled = (host: ArchiveHost, startedAt: number): void => {
  const readyAt = archiveReadyAt(host, startedAt)
  if (Date.now() < readyAt)
    throw new ArchiveError('Cached gate reads are still expiring. Retry shortly.', 409, readyAt)
}
