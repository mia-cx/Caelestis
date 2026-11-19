import { type Millis, millis, type Seconds, seconds } from '@caelestis/shared'
import { FLUSH_BATCH_LIMIT } from '../db/d1-limits.js'
import {
  EXPIRES_AFTER_SECONDS,
  FLUSHABLE_AFTER_SECONDS,
  RESOLUTION_SECONDS,
} from '../ports/index.js'
import { serialQueue } from '../runtime/serial-queue.js'
import type { TelemetryBucket } from '../telemetry/history/ladder.js'
import type { HistoryStore } from '../telemetry/history/store.js'
import { COUNTER_VALUES } from './counter-tables.js'
import type { AlarmStorage, CoordinatorDatabase } from './database.js'

const INITIAL_FLUSH_RETRY_DELAY_MILLISECONDS = 1_000
const MAX_FLUSH_RETRY_DELAY_MILLISECONDS = 60_000

const flushRetryDelay = (failureCount: number): number =>
  Math.min(
    INITIAL_FLUSH_RETRY_DELAY_MILLISECONDS * 2 ** Math.max(0, failureCount - 1),
    MAX_FLUSH_RETRY_DELAY_MILLISECONDS,
  )

interface CounterRow {
  readonly template_id: string
  readonly bucket_start_s: Seconds
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

interface CountRow {
  readonly count: number
}

interface NextBucketRow {
  readonly bucket_start_s: Seconds | null
}

// SqlStorage's variadic bind API accepts every numeric unit. Route timestamp values through these
// unit-specific adapters so a seconds/milliseconds swap is rejected before it reaches that API.
export const bindSeconds = (value: Seconds): number => value
export const bindMillis = (value: Millis): number => value

/** Moves due counters to D1 in batches, retains what D1 holds, and owns the coordinator's alarm. */
export class CounterFlusher {
  /** Keeps a stale empty read from deleting a newer record's wakeup or replacing its backoff. */
  private readonly updateAlarm = serialQueue()
  /**
   * When the oldest unexpired retained row expires, as of the last prune. `null` is unknown, after
   * startup or a restore, and makes the next record prune.
   */
  private retainedExpiresAt: Seconds | null = null

  constructor(
    private readonly database: CoordinatorDatabase,
    private readonly alarms: AlarmStorage,
    private readonly sql: HistoryStore,
    private readonly clock: () => Millis,
  ) {}

  /** Restored retained rows may expire sooner than any row the last prune saw. */
  forgetRetainedExpiry(): void {
    this.retainedExpiresAt = null
  }

  /**
   * A successful flush leaves retained reconciliation state but no alarm. The next write is a
   * lifecycle opportunity to reclaim expired rows, taken only once a retained row has expired.
   */
  async pruneExpired(nowSeconds: Seconds): Promise<void> {
    if (this.retainedExpiresAt === null || this.retainedExpiresAt <= nowSeconds)
      await this.pruneRetained(nowSeconds)
  }

  async readFailureCount(): Promise<number> {
    return (
      await this.database.one<CountRow>(
        'SELECT consecutive_failures AS count FROM flush_retry_state WHERE singleton = 1',
      )
    ).count
  }

  /** Wake at `time`, whatever is already scheduled. */
  wakeAt(time: Millis): Promise<void> {
    return this.updateAlarm(() => this.alarms.setAlarm(time))
  }

  scheduleNext(nowMilliseconds: Millis): Promise<void> {
    return this.updateAlarm(() => this.reconcileAlarm(nowMilliseconds))
  }

  async flush(nowMilliseconds: Millis): Promise<void> {
    const nowSeconds = seconds(Math.floor(nowMilliseconds / 1_000))
    await this.pruneRetained(nowSeconds)
    // Valid deltas never create a zero row; this keeps one from lingering if a writer ever does.
    await this.database.run(
      'DELETE FROM pending_counters WHERE placed = 0 AND correct = 0 AND repairs = 0',
    )
    let rows = await this.readBatch()

    if (rows.length === 0) {
      // Pending activity accumulated during a failed D1 write stays put. Once the preserved batch
      // succeeds and clears, the next alarm promotes and drains that pending activity.
      await this.database.transaction(async (database) => {
        await database.run(
          `
            INSERT INTO flush_batch (template_id, bucket_start_s, ${COUNTER_VALUES.join(', ')})
            SELECT
              pending.template_id,
              pending.bucket_start_s,
              ${COUNTER_VALUES.map((value) => `pending.${value} + COALESCE(retained.${value}, 0)`).join(', ')}
            FROM pending_counters AS pending
            LEFT JOIN retained_counters AS retained
              ON retained.template_id = pending.template_id
             AND retained.bucket_start_s = pending.bucket_start_s
            WHERE pending.bucket_start_s + ?1 <= ?2
              AND (pending.placed <> 0 OR pending.correct <> 0 OR pending.repairs <> 0)
          `,
          FLUSHABLE_AFTER_SECONDS,
          bindSeconds(nowSeconds),
        )
        await database.run(
          `
            DELETE FROM pending_counters
            WHERE bucket_start_s + ?1 <= ?2
              AND (placed <> 0 OR correct <> 0 OR repairs <> 0)
          `,
          FLUSHABLE_AFTER_SECONDS,
          bindSeconds(nowSeconds),
        )
      })
      rows = await this.readBatch()
    }

    if (rows.length > 0) {
      const buckets: readonly TelemetryBucket[] = rows.map((row) => ({
        templateId: row.template_id,
        resolution: RESOLUTION_SECONDS,
        bucketStart: row.bucket_start_s,
        placed: row.placed,
        correct: row.correct,
        repairs: row.repairs,
      }))

      // D1 must commit before retained_counters advances: advancing retained first makes
      // readPending subtract the batch from itself and report zero for the whole of a D1 outage.
      // The cost: if D1 commits but the response is lost, retained does not advance, and live
      // totals read high by that batch until the next flush succeeds. Reading high while
      // recovering beats reading zero, which would hide work.
      try {
        await this.sql.appendAndFold(buckets, nowSeconds)
      } catch (error) {
        // Schedule the retry and return normally rather than rethrowing. Cloudflare retries a
        // throwing alarm() at most six times, backing off from 2 seconds, and recommends scheduling
        // a new alarm for indefinite retries; rethrowing would strand flush_batch after about two
        // minutes of D1 outage. Returning reports success to the platform, so
        // readFlushFailureCount() is the signal to watch; the batch stays in flush_batch until D1
        // confirms. https://developers.cloudflare.com/durable-objects/api/alarms/
        const failureCount = (await this.readFailureCount()) + 1
        await this.database.run(
          'UPDATE flush_retry_state SET consecutive_failures = ?1 WHERE singleton = 1',
          failureCount,
        )
        const retryDelay = flushRetryDelay(failureCount)
        console.error(
          `telemetry flush failed (attempt ${failureCount}), retrying in ${retryDelay}ms`,
          error,
        )
        await this.wakeAt(millis(this.clock() + retryDelay))
        return
      }

      await this.database.transaction(async (database) => {
        await database.run(
          'UPDATE flush_retry_state SET consecutive_failures = 0 WHERE singleton = 1',
        )
        for (const row of rows) {
          await database.run(
            `
              INSERT INTO retained_counters (
                template_id, bucket_start_s, placed, correct, repairs
              ) VALUES (?1, ?2, ?3, ?4, ?5)
              ON CONFLICT (template_id, bucket_start_s) DO UPDATE SET
                placed = excluded.placed,
                correct = excluded.correct,
                repairs = excluded.repairs
            `,
            row.template_id,
            bindSeconds(row.bucket_start_s),
            row.placed,
            row.correct,
            row.repairs,
          )
          await database.run(
            `
              INSERT INTO counter_meta (template_id, flushed_at)
              VALUES (?1, ?2)
              ON CONFLICT (template_id) DO UPDATE SET flushed_at = excluded.flushed_at
            `,
            row.template_id,
            bindMillis(nowMilliseconds),
          )
          await database.run(
            'DELETE FROM flush_batch WHERE template_id = ?1 AND bucket_start_s = ?2',
            row.template_id,
            bindSeconds(row.bucket_start_s),
          )
        }
      })
    }

    await this.pruneRetained(nowSeconds)
    await this.scheduleNext(nowMilliseconds)
  }

  private readBatch(): Promise<CounterRow[]> {
    return this.database.all<CounterRow>(
      `
        SELECT template_id, bucket_start_s, placed, correct, repairs
        FROM flush_batch
        ORDER BY template_id, bucket_start_s
        LIMIT ?1
      `,
      FLUSH_BATCH_LIMIT,
    )
  }

  async pruneRetained(nowSeconds: Seconds): Promise<void> {
    // The bound is on the bare column so the bucket index can serve it.
    const expiredThrough = bindSeconds(seconds(nowSeconds - EXPIRES_AFTER_SECONDS))
    await this.database.run(
      `
        DELETE FROM retained_counters
        WHERE bucket_start_s <= ?1
          AND NOT EXISTS (
            SELECT 1
            FROM pending_counters
            WHERE pending_counters.template_id = retained_counters.template_id
              AND pending_counters.bucket_start_s = retained_counters.bucket_start_s
          )
          AND NOT EXISTS (
            SELECT 1
            FROM flush_batch
            WHERE flush_batch.template_id = retained_counters.template_id
              AND flush_batch.bucket_start_s = retained_counters.bucket_start_s
          )
      `,
      expiredThrough,
    )
    // Rows that outlived expiry because pending or flush-batch state still needs them are retried
    // by every flush, so records wait only for the oldest row that has not expired yet.
    const { bucket_start_s: oldest } = await this.database.one<NextBucketRow>(
      'SELECT MIN(bucket_start_s) AS bucket_start_s FROM retained_counters WHERE bucket_start_s > ?1',
      expiredThrough,
    )
    // With nothing retained, nothing expires until a flush retains a row, and that flush prunes.
    this.retainedExpiresAt = seconds(
      oldest === null ? Number.POSITIVE_INFINITY : Number(oldest) + EXPIRES_AFTER_SECONDS,
    )
  }

  private async reconcileAlarm(nowMilliseconds: Millis): Promise<void> {
    const flushBatchPending =
      (await this.database.all('SELECT 1 FROM flush_batch LIMIT 1')).length > 0
    if (flushBatchPending) {
      const scheduledAlarm = await this.alarms.getAlarm()
      if (scheduledAlarm === null || scheduledAlarm <= nowMilliseconds) {
        await this.alarms.setAlarm(nowMilliseconds)
      }
      return
    }

    const nextBucket = (
      await this.database.one<NextBucketRow>(
        `
          SELECT MIN(bucket_start_s) AS bucket_start_s
          FROM pending_counters
          WHERE placed <> 0 OR correct <> 0 OR repairs <> 0
        `,
      )
    ).bucket_start_s
    if (nextBucket === null) {
      await this.alarms.deleteAlarm()
      return
    }

    const flushableAtMilliseconds = millis((nextBucket + FLUSHABLE_AFTER_SECONDS) * 1_000)
    await this.alarms.setAlarm(Math.max(nowMilliseconds, flushableAtMilliseconds))
  }
}
