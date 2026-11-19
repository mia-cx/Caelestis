import { type Millis, seconds } from '@caelestis/shared'
import type { SqlStore } from '../ports/index.js'
import { ALARM_FOLLOW_UP_RETRY_MILLISECONDS } from './alarms/policy.js'
import { type FetcherStores, fetchAlarmFollowUps } from './fetcher.js'

const ALARM_BATCH_DELAY_MILLISECONDS = 1_000

/** The alarm wakeup: a Durable Object's own alarm, or Node's durable `alarms` actor. */
interface AlarmWakeup {
  setAlarm(scheduledTime: number): Promise<void>
}

/** Reconcile the wakeup with the earliest durable probe stored in SQL. */
export const scheduleAlarmWakeup = async (sql: SqlStore, wakeup: AlarmWakeup): Promise<void> => {
  const dueAt = await sql.nextAlarmProbeAt()
  // Do not delete when empty: a concurrent schedule may have installed a wakeup after this read.
  // A stale alarm can safely wake once and reconcile an empty queue.
  if (dueAt !== null) await wakeup.setAlarm(dueAt)
}

/** Run one bounded durable probe cycle and retain ownership of all retries. */
export const runAlarmWatcherCycle = async (
  stores: FetcherStores,
  wakeup: AlarmWakeup,
  now: Millis,
): Promise<void> => {
  try {
    const probes = await stores.sql.listDueAlarmProbes(now)
    const report = await fetchAlarmFollowUps(stores, probes, {
      now: seconds(Math.floor(now / 1_000)),
    })
    const decidedAt = Date.now()
    if (report.failed > 0) {
      await wakeup.setAlarm(decidedAt + ALARM_FOLLOW_UP_RETRY_MILLISECONDS)
      return
    }
    const dueAt = await stores.sql.nextAlarmProbeAt()
    if (dueAt === null) {
      // A concurrent schedule may have installed a replacement wakeup after this D1 read. The
      // currently firing alarm is already consumed, so leaving storage untouched is race-safe.
      return
    }
    await wakeup.setAlarm(
      report.pending > 0 ? Math.max(dueAt, decidedAt + ALARM_BATCH_DELAY_MILLISECONDS) : dueAt,
    )
  } catch (error) {
    // Cloudflare gives a throwing alarm only a bounded retry series. Keep the durable D1 probe
    // and own an indefinite, paced retry instead of stranding it until the next six-hour cron.
    console.error('alarm watcher cycle failed; retrying', error)
    await wakeup.setAlarm(Date.now() + ALARM_FOLLOW_UP_RETRY_MILLISECONDS)
  }
}
