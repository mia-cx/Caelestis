import { millis, seconds } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coordinatorDatabase } from '../src/adapters/node/coordinator-database.js'
import { RelationalSqlStore } from '../src/adapters/relational-sql-store.js'
import type { AlarmStorage } from '../src/coordination/database.js'
import { TelemetryCoordinator } from '../src/coordination/telemetry.js'
import { EXPIRES_AFTER_SECONDS, FLUSHABLE_AFTER_SECONDS } from '../src/ports/index.js'
import { openRelationalStore } from './support/relational.js'

class FailOnceSqlStore extends RelationalSqlStore {
  private failed = false
  override async appendBuckets(...parameters: Parameters<RelationalSqlStore['appendBuckets']>) {
    if (!this.failed) {
      this.failed = true
      throw new Error('temporary persistence failure')
    }
    await super.appendBuckets(...parameters)
  }
}

describe('durable telemetry coordinator', () => {
  const closes: Array<() => Promise<void>> = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(closes.splice(0).map((close) => close()))
  })

  it('deduplicates delivery, retains a failed flush, and retries it without double credit', async () => {
    const opened = await openRelationalStore()
    closes.push(opened.close)
    let now = millis(100_000)
    const alarms: AlarmStorage & { last: number | null } = {
      last: null,
      getAlarm: async () => alarms.last,
      setAlarm: async (time) => {
        alarms.last = time
      },
      deleteAlarm: async () => {
        alarms.last = null
      },
    }
    const sql = new FailOnceSqlStore(opened.connection)
    const coordinator = new TelemetryCoordinator(
      coordinatorDatabase(opened.connection),
      alarms,
      sql,
      () => now,
    )
    await coordinator.initialize()
    const delta = {
      templateId: 'template',
      occurredAt: seconds(0),
      placed: 3,
      correct: 2,
      repairs: 1,
    }

    await coordinator.record([delta], 'delivery-1')
    await coordinator.record([delta], 'delivery-1')
    expect(await coordinator.readPending(['template'])).toEqual([
      { templateId: 'template', placed: 3, correct: 2, repairs: 1, flushedAt: null },
    ])

    vi.spyOn(console, 'error').mockImplementation(() => {})
    await coordinator.alarm()
    expect(await coordinator.readFlushFailureCount()).toBe(1)
    expect(alarms.last).toBe(101_000)
    expect((await coordinator.readPending(['template']))[0]).toMatchObject({
      placed: 3,
      flushedAt: null,
    })

    now = millis(101_000)
    await coordinator.alarm()
    expect(await coordinator.readFlushFailureCount()).toBe(0)
    expect((await coordinator.readPending(['template']))[0]).toMatchObject({
      placed: 0,
      flushedAt: now,
    })
    expect(
      await sql.readBuckets({
        templateIds: ['template'],
        resolution: 60,
        fromSeconds: seconds(0),
        toSeconds: seconds(60),
      }),
    ).toEqual([
      {
        templateId: 'template',
        resolution: 60,
        bucketStart: seconds(0),
        placed: 3,
        correct: 2,
        repairs: 1,
      },
    ])
  })

  it('keeps flushed counters until they expire, then the next record reclaims them', async () => {
    const opened = await openRelationalStore()
    closes.push(opened.close)
    let now = millis(100_000)
    let alarm: number | null = null
    const coordinator = new TelemetryCoordinator(
      coordinatorDatabase(opened.connection),
      {
        getAlarm: async () => alarm,
        setAlarm: async (time) => {
          alarm = time
        },
        deleteAlarm: async () => {
          alarm = null
        },
      },
      opened.sql,
      () => now,
    )
    await coordinator.initialize()
    const record = (templateId: string) =>
      coordinator.record([
        {
          templateId,
          occurredAt: seconds(Math.floor(now / 1_000)),
          placed: 1,
          correct: 1,
          repairs: 0,
        },
      ])
    const retained = async () =>
      (await coordinator.exportCounterRows('retained_counters', null, 10)).map(
        (row) => row.template_id,
      )

    await record('flushed')
    now = millis((60 + FLUSHABLE_AFTER_SECONDS) * 1_000)
    await coordinator.alarm()
    expect(await retained()).toEqual(['flushed'])

    // The flushed bucket starts at 60 and expires EXPIRES_AFTER_SECONDS later.
    now = millis((60 + EXPIRES_AFTER_SECONDS - 1) * 1_000)
    await record('later')
    expect(await retained()).toEqual(['flushed'])
    now = millis((60 + EXPIRES_AFTER_SECONDS) * 1_000)
    await record('later')
    expect(await retained()).toEqual([])
  })
})
