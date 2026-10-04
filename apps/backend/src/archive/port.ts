import type { ObjectStorage } from '@caelestis/storage'
import type { SqlConnection } from '../adapters/sql-connection.js'
import type { BackfillStatePage } from '../backfill/import.js'
import type { CounterArchiveTable } from '../coordination/telemetry.js'

/** The telemetry coordinator's durable tables, wherever the runtime keeps them. */
export interface CounterArchive {
  exportCounterRows(
    table: CounterArchiveTable,
    after: readonly (string | number)[] | null,
    limit: number,
  ): Promise<Record<string, string | number>[]>
  importCounterRows(
    table: CounterArchiveTable,
    rows: readonly Readonly<Record<string, string | number>>[],
  ): Promise<void>
  /** Empty every table and reseed the singletons, as on a new server. */
  discardCounterRows(): Promise<void>
  /** Refuse new records and wait for admitted ones; flushes and pruning wait too. */
  freeze(): Promise<void>
  thaw(): Promise<void>
}

/** One template's resumable import state, wherever the runtime keeps it. */
export interface BackfillArchive {
  exportState(startAfter: string | null, limit: number): Promise<BackfillStatePage>
  importState(page: BackfillStatePage): Promise<void>
  /** Delete up to `limit` keys and the alarm; true once nothing is left. */
  discardState(limit: number): Promise<boolean>
}

/**
 * Everything a server archive reads or restores, expressed in portable contracts. The database is
 * the raw connection: archive operations are the one writer the gate admits.
 */
export interface ArchiveHost {
  readonly connection: SqlConnection
  readonly objects: ObjectStorage
  readonly counters: CounterArchive
  readonly backfill: (templateId: string) => BackfillArchive
  readonly serverId: string
  /** Re-arm wakeups that read restored data, such as alarm probes. */
  readonly activated: () => Promise<void>
  /** Overrides ARCHIVE_SETTLE_MILLISECONDS, the restore's wait for cached gate reads. */
  readonly settleMilliseconds?: number
}
