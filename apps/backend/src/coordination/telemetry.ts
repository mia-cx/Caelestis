import { type Millis, millis, type Seconds, seconds } from '@caelestis/shared'
import { ArchiveOperationActiveError } from '../archive/errors.js'
import type { ArchiveStatus } from '../archive/store.js'
import {
  addCounters,
  COUNTER_IDEMPOTENCY_RETENTION_SECONDS,
  type CounterDelta,
  type CounterValues,
  canAccumulateCounters,
  isValidCounterDelta,
  MAX_COUNTER_DELTAS_PER_RECORD,
  type PendingCounters,
  RESOLUTION_SECONDS,
} from '../ports/index.js'
import type { HistoryStore } from '../telemetry/history/store.js'
import {
  COUNTER_OPERATION,
  discardCounterRows,
  exportCounterRows,
  importCounterRows,
  moveCounterOperation,
} from './counter-archive.js'
import { bindMillis, bindSeconds, CounterFlusher } from './counter-flush.js'
import {
  COUNTER_VALUES,
  type CounterArchiveTable,
  CUMULATIVE_BUCKET,
  initializeCounterTables,
  outstandingRows,
} from './counter-tables.js'
import type { AlarmStorage, CoordinatorDatabase } from './database.js'

// The counters query binds every id twice. Stay below SQLite's conservative 999-variable default,
// not merely workerd's current higher limit, so large manifest groups remain portable.
const READ_PENDING_CHUNK_SIZE = 400

const ARCHIVE_RETRY_DELAY_MILLISECONDS = 60_000

interface CounterValuesRow {
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

interface PendingRow extends CounterValuesRow {
  readonly template_id: string
}

interface FlushedAtRow {
  readonly template_id: string
  readonly flushed_at: Millis
}

interface CountRow {
  readonly count: number
}

const SUMMED = COUNTER_VALUES.map((value) => `COALESCE(SUM(${value}), 0) AS ${value}`).join(', ')

const hasActivity = ({ placed, correct, repairs }: CounterDelta): boolean =>
  placed > 0 || correct > 0 || repairs > 0

const eventBucketStart = (occurredAt: Seconds): Seconds =>
  seconds(Math.floor(occurredAt / RESOLUTION_SECONDS) * RESOLUTION_SECONDS)

/**
 * The durable counter ledger: it validates and records deltas once each, answers what has not
 * reached D1 yet, and admits writes only while no archive operation holds it still. Flushing to D1
 * is the `CounterFlusher`'s; archive row transfer is `counter-archive.ts`'s.
 */
export class TelemetryCoordinator {
  private readonly flusher: CounterFlusher
  /** Archive operations holding this state; see `freeze`. Durable in `counter_freeze`. */
  private freezes: ReadonlySet<string> = new Set()
  /** Records and flushes that passed the freeze check and may still write. */
  private readonly admitted = new Set<Promise<void>>()

  constructor(
    private readonly database: CoordinatorDatabase,
    alarms: AlarmStorage,
    private readonly sql: HistoryStore & ArchiveStatus,
    private readonly clock: () => Millis = () => millis(Date.now()),
  ) {
    this.flusher = new CounterFlusher(database, alarms, sql, clock)
  }

  async initialize(): Promise<void> {
    await initializeCounterTables(this.database)
    // Union, not replace: a freeze taken while this read ran must survive it.
    this.freezes = new Set([...this.freezes, ...(await this.readFreezes())])
    const now = this.clock()
    // Pruning would change state an archive is reading; a frozen coordinator prunes after thawing.
    if (this.freezes.size === 0) await this.flusher.pruneRetained(seconds(Math.floor(now / 1_000)))
    await this.flusher.scheduleNext(now)
  }

  private async readFreezes(): Promise<ReadonlySet<string>> {
    const rows = await this.database.all<{ operation_id: string }>(
      'SELECT operation_id FROM counter_freeze',
    )
    return new Set(rows.map((row) => row.operation_id))
  }

  /**
   * Run mutating work only while no archive operation holds this state, and track it from that
   * check to its last write so `freeze` can wait for it. Returns false, running nothing, while
   * frozen.
   */
  private async admit(work: () => Promise<void>): Promise<boolean> {
    if (this.freezes.size > 0) await this.clearStaleFreezes()
    // Checked again with no await before admission, so a freeze cannot slip in between.
    if (this.freezes.size > 0) return false
    const running = work()
    this.admitted.add(running)
    try {
      await running
    } finally {
      this.admitted.delete(running)
    }
    return true
  }

  async record(deltas: readonly CounterDelta[], idempotencyKey?: string): Promise<void> {
    if (!(await this.admit(() => this.recordUnfrozen(deltas, idempotencyKey))))
      throw new ArchiveOperationActiveError()
  }

  private async recordUnfrozen(
    deltas: readonly CounterDelta[],
    idempotencyKey?: string,
  ): Promise<void> {
    const nowMilliseconds = this.clock()
    const nowSeconds = seconds(Math.floor(nowMilliseconds / 1_000))
    await this.flusher.pruneExpired(nowSeconds)

    await this.database.transaction(async (database) => {
      await database.run(
        'DELETE FROM applied_counter_events WHERE seen_at_ms <= ?1',
        bindMillis(millis(nowMilliseconds - COUNTER_IDEMPOTENCY_RETENTION_SECONDS * 1_000)),
      )
      if (idempotencyKey !== undefined) {
        const claimed = await database.run(
          `INSERT INTO applied_counter_events (event_id, seen_at_ms) VALUES (?1, ?2) ON CONFLICT DO NOTHING`,
          idempotencyKey,
          bindMillis(nowMilliseconds),
        )
        if (claimed.rowsWritten === 0) return
      }

      const boundedDeltas = deltas.slice(0, MAX_COUNTER_DELTAS_PER_RECORD)
      let droppedLate = deltas.length - boundedDeltas.length
      const outstandingByTemplate = new Map<string, CounterValues>()
      const cumulativeByBucket = new Map<string, CounterValues>()

      for (const delta of boundedDeltas) {
        // Keep one operational counter for all rejected input: both malformed and out-of-window
        // deltas have the same outcome and remediation, and splitting them would add schema surface.
        if (!isValidCounterDelta(delta, nowSeconds)) {
          droppedLate += 1
          continue
        }
        if (!hasActivity(delta)) continue

        const bucketStart = eventBucketStart(delta.occurredAt)
        const key = `${delta.templateId}\u0000${bucketStart}`
        const outstanding =
          outstandingByTemplate.get(delta.templateId) ??
          (await database.one<CounterValuesRow>(
            `SELECT ${SUMMED} FROM (${outstandingRows((column) => `${column} = ?1`)}) AS outstanding`,
            delta.templateId,
          ))
        const cumulative =
          cumulativeByBucket.get(key) ??
          (await database.one<CounterValuesRow>(
            CUMULATIVE_BUCKET,
            delta.templateId,
            bindSeconds(bucketStart),
          ))
        if (
          !canAccumulateCounters(outstanding, delta) ||
          !canAccumulateCounters(cumulative, delta)
        ) {
          droppedLate += 1
          continue
        }
        await database.run(
          `
          INSERT INTO pending_counters (
            template_id, bucket_start_s, placed, correct, repairs
          ) VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT (template_id, bucket_start_s) DO UPDATE SET
            placed = pending_counters.placed + excluded.placed,
            correct = pending_counters.correct + excluded.correct,
            repairs = pending_counters.repairs + excluded.repairs
        `,
          delta.templateId,
          bindSeconds(bucketStart),
          delta.placed,
          delta.correct,
          delta.repairs,
        )
        outstandingByTemplate.set(delta.templateId, addCounters(outstanding, delta))
        cumulativeByBucket.set(key, addCounters(cumulative, delta))
      }

      if (droppedLate > 0) {
        await database.run(
          `
          UPDATE counter_stats
          SET dropped_late_deltas = dropped_late_deltas + ?1
          WHERE singleton = 1
        `,
          droppedLate,
        )
      }
    })

    await this.flusher.scheduleNext(nowMilliseconds)
  }

  async readPending(templateIds: readonly string[]): Promise<readonly PendingCounters[]> {
    await this.flusher.scheduleNext(this.clock())
    if (templateIds.length === 0) return []

    const countersByTemplate = new Map<string, PendingRow>()
    const flushedAtByTemplate = new Map<string, Millis>()
    for (let offset = 0; offset < templateIds.length; offset += READ_PENDING_CHUNK_SIZE) {
      const chunk = templateIds.slice(offset, offset + READ_PENDING_CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(', ')
      const counters = await this.database.all<PendingRow>(
        `
          SELECT template_id, ${SUMMED}
          FROM (${outstandingRows((column) => `${column} IN (${placeholders})`)}) AS outstanding
          GROUP BY template_id
        `,
        ...chunk,
        ...chunk,
      )
      const metadata = await this.database.all<FlushedAtRow>(
        `
          SELECT template_id, flushed_at
          FROM counter_meta
          WHERE template_id IN (${placeholders})
        `,
        ...chunk,
      )
      for (const row of counters) countersByTemplate.set(row.template_id, row)
      for (const row of metadata) flushedAtByTemplate.set(row.template_id, row.flushed_at)
    }

    return templateIds.map((templateId) => {
      const row = countersByTemplate.get(templateId)
      const flushedAt = flushedAtByTemplate.get(templateId)
      return {
        templateId,
        placed: row?.placed ?? 0,
        correct: row?.correct ?? 0,
        repairs: row?.repairs ?? 0,
        flushedAt: flushedAt ?? null,
      }
    })
  }

  async readDroppedLateCount(): Promise<number> {
    return (
      await this.database.one<CountRow>(
        'SELECT dropped_late_deltas AS count FROM counter_stats WHERE singleton = 1',
      )
    ).count
  }

  readFlushFailureCount(): Promise<number> {
    return this.flusher.readFailureCount()
  }

  exportCounterRows(
    table: CounterArchiveTable,
    after: readonly (string | number)[] | null,
    limit: number,
  ): Promise<Record<string, string | number>[]> {
    return exportCounterRows(this.database, table, after, limit)
  }

  /** Open counter rows to `operationId`'s imports. */
  beginCounterImport(operationId: string): Promise<void> {
    return moveCounterOperation(this.database, operationId, COUNTER_OPERATION.importing)
  }

  /** Stop `operationId`'s imports; its own discard may still clean the rows it wrote. */
  beginCounterDiscard(operationId: string): Promise<void> {
    return moveCounterOperation(this.database, operationId, COUNTER_OPERATION.cleaning)
  }

  /** Neither imports nor cleanup may write for `operationId` again. */
  closeCounterOperation(operationId: string): Promise<void> {
    return moveCounterOperation(this.database, operationId, COUNTER_OPERATION.closed)
  }

  /** Restore archived rows, then wake the flush they may need. */
  async importCounterRows(
    operationId: string,
    table: CounterArchiveTable,
    rows: readonly Readonly<Record<string, string | number>>[],
  ): Promise<void> {
    await importCounterRows(this.database, operationId, table, rows)
    if (table === 'retained_counters') this.flusher.forgetRetainedExpiry()
    await this.flusher.scheduleNext(this.clock())
  }

  discardCounterRows(operationId: string): Promise<void> {
    return discardCounterRows(this.database, operationId)
  }

  /**
   * Hold this state still for an archive operation, keyed by its id. New records fail at once and
   * records already admitted finish first, so each one is either in the archive or refused; a
   * refused paint is retried by its client wherever the server's data then lives. The in-memory
   * set only grows here and shrinks in `thaw` for the same id, so a stale read cannot reopen
   * admission.
   */
  async freeze(operationId: string): Promise<void> {
    this.freezes = new Set([...this.freezes, operationId])
    await this.database.run(
      'INSERT INTO counter_freeze (operation_id) VALUES (?1) ON CONFLICT DO NOTHING',
      operationId,
    )
    await Promise.allSettled([...this.admitted])
  }

  /** Clear one operation's freeze; a late call for an older operation leaves a newer one alone. */
  async thaw(operationId: string): Promise<void> {
    await this.database.run('DELETE FROM counter_freeze WHERE operation_id = ?1', operationId)
    const remaining = new Set(this.freezes)
    remaining.delete(operationId)
    this.freezes = remaining
    if (remaining.size === 0) await this.flusher.scheduleNext(this.clock())
  }

  /**
   * Clear freezes whose operation no longer holds the server: a caller died between freezing and
   * undoing. With the gate open, every id read before that check is stale, and a newer id is
   * written only after its gate closed, so only stale ids are thawed, one by one.
   */
  private async clearStaleFreezes(): Promise<void> {
    const observed = await this.readFreezes()
    if (observed.size > 0 && !(await this.sql.archiveOperationActive({ fresh: true })))
      for (const operationId of observed) await this.thaw(operationId)
  }

  /**
   * Flushing moves pending counters before it writes buckets. During an archive operation that
   * would change the state being exported or restored, so a frozen coordinator only re-arms, and
   * a flush admitted earlier is part of what `freeze` waits for.
   */
  async alarm(): Promise<void> {
    const nowMilliseconds = this.clock()
    if (await this.admit(() => this.flusher.flush(nowMilliseconds))) return
    await this.flusher.wakeAt(millis(nowMilliseconds + ARCHIVE_RETRY_DELAY_MILLISECONDS))
  }
}
