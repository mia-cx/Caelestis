import { millis } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openMemoryStores } from '../node/memory-stores.js'
import { runAlarmWatcherCycle } from './alarm-watcher-cycle.js'
import { ALARM_FOLLOW_UP_RETRY_MILLISECONDS } from './alarms/policy.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('alarm watcher cycle', () => {
  it('logs a failed cycle and paces its own retry', async () => {
    const stores = await openMemoryStores()
    const failure = new Error('no such table: alarm_probes')
    vi.spyOn(stores.sql, 'listDueAlarmProbes').mockRejectedValue(failure)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const alarms: number[] = []

    const before = Date.now()
    await runAlarmWatcherCycle(
      stores,
      { setAlarm: async (at) => void alarms.push(at) },
      millis(before),
    )

    expect(logged).toHaveBeenCalledWith(expect.any(String), failure)
    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toBeGreaterThanOrEqual(before + ALARM_FOLLOW_UP_RETRY_MILLISECONDS)
    stores.close()
  })
})
