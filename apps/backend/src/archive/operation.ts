import { uuidV7 } from '@caelestis/shared'
import { ArchiveError } from './format.js'
import {
  ARCHIVE_SETTLE_MILLISECONDS,
  type ArchiveLease,
  type ArchiveOperationRow,
  acquireArchiveLease,
  closeProcessWrites,
  openProcessWrites,
  readArchiveOperation,
  releaseArchiveLease,
} from './gate.js'
import type { ArchiveHost } from './port.js'

/**
 * The archive operation lifecycle. The `archive_operation` row is the durable record of the one
 * operation a server runs, and its `state_json` carries the phase:
 *
 *   export:  freezing → frozen → releasing → (row deleted)
 *   import:  preparing → ready → releasing → (row deleted)
 *            preparing → releasing            (refused or cancelled before anything was restored)
 *            ready → discarding → releasing   (discard; ready includes the ended archive)
 *
 * Concurrency is closed in two layers, because a restore and its discard write to stores that
 * cannot share one transaction:
 *
 * 1. The `archive_lease` row serializes requests: every lifecycle entry point that writes takes
 *    it with one compare-and-set before doing anything, and hands it back in `finally`. A second
 *    request gets 409. Each lease has a fence that bumps on every take-over and a TTL, so a
 *    crashed holder can only stall work until the lease expires. Near its deadline a call saves
 *    progress and returns, the way the chunked steps always could. Status reads stay lock-free.
 * 2. Fences keep a stale call safe even after its lease is taken over. Every batch an archive
 *    call writes leads with `archiveFence`: a constraint-violating insert that fires exactly
 *    when the operation row no longer carries the expected state or the lease no longer carries
 *    the call's fence, aborting the whole batch. The counter store keeps a per-operation state
 *    (importing → cleaning → closed, never backwards) that imports and cleanup must move inside
 *    their own transaction, and outside writes check the call's deadline first, so a stalled
 *    caller stops before it can touch a store its lease no longer covers. Discard records the
 *    template ids it must clean before it deletes the rows that carried them, and its final
 *    pass checks that backfill state by id; a write that slipped past its own deadline is
 *    found there and cleaned on the repeat pass.
 * 3. Every transition is a compare-and-set on the whole prior row: operation id, position, and
 *    state. A caller whose read went stale changes nothing and gets 409.
 * 4. Holds belong to the operation, keyed by its id, never to a call. Any call may add one while
 *    the row holds the server; only a call that has proven the operation no longer holds may
 *    remove one. In-memory copies only add on a hold and drop on that removal; no read replaces
 *    them. Each probe of the object store uses its own random key.
 * 5. Writes reopen last. Releasing closes the counter operation state, then deletes the row,
 *    then thaws the freeze, then opens the process gate — so records and flushes stay refused
 *    while the operation still holds, and a crash between the delete and the thaw leaves only a
 *    freeze `clearStaleFreezes` drops on the next write. A failure earlier leaves the row in
 *    `releasing`, still holding the server, and the next lifecycle call finishes it.
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

/** The archive lease was already taken when this request asked. Distinct from `changedError`. */
export const leaseBusyError = () =>
  new ArchiveError('Another archive request is running. Retry shortly.', 409)

/** The call reached its deadline; whatever it wrote outside the database stays idempotent. */
export class ArchiveLeaseDeadline extends ArchiveError {
  constructor() {
    super('This archive request ran out of time. Send it again to continue.', 409)
  }
}

/** Refuse an external write or delete once this call is inside its lease's margin. */
export const checkArchiveDeadline = (lease: ArchiveLease): void => {
  if (Date.now() >= lease.deadline) throw new ArchiveLeaseDeadline()
}

/**
 * Run one archive lifecycle request holding the lease, so at most one writes at a time across
 * every process the database serves. The lease is handed back whatever happens; a holder that
 * dies is taken over when its TTL expires.
 */
export const withArchiveLease = async <T>(
  host: ArchiveHost,
  operation: (lease: ArchiveLease) => Promise<T>,
): Promise<T> => {
  const lease = await acquireArchiveLease(host.connection)
  if (lease === null) throw leaseBusyError()
  try {
    return await operation(lease)
  } finally {
    // A failed release is harmless: the lease expires on its own, and masking the
    // operation's own error would hide the real outcome.
    await releaseArchiveLease(host.connection, lease).catch(() => {})
  }
}

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
export const holdFor = async (host: ArchiveHost, operation: ArchiveOperationRow): Promise<void> => {
  await closeProcessWrites(host.connection, operation.operationId)
  await host.counters.freeze(operation.operationId)
  const current = await readArchiveOperation(host.connection)
  const ours = current?.operationId === operation.operationId
  if (ours && current !== null && HOLDING.has(phaseOf(current))) return
  // The operation no longer holds the server, so nobody needs its holds any more.
  await host.counters.thaw(operation.operationId)
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

/**
 * Close the counter operation, delete the row, then thaw and reopen this process's writes.
 * Counters close first so nothing the operation holds can write once it ends; the freeze stays
 * until the row is gone, so records never slip into a `releasing` operation. A crash between
 * the delete and the thaw leaves a freeze `clearStaleFreezes` drops when it sees the gate open.
 */
const completeRelease = async (host: ArchiveHost, operation: ArchiveOperationRow) => {
  await host.counters.closeCounterOperation(operation.operationId)
  await host.connection
    .prepare(
      'DELETE FROM "archive_operation" WHERE "id" = 1 AND "operation_id" = ? AND "state_json" = ?',
    )
    .bind(operation.operationId, operation.stateJson)
    .run()
  try {
    await host.counters.thaw(operation.operationId)
  } finally {
    // The row is gone: this operation's in-process hold must end even when the thaw failed —
    // the freeze it leaves behind is cleaned by `clearStaleFreezes`.
    openProcessWrites(host.connection, operation.operationId)
  }
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
