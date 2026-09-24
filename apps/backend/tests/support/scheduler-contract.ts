import { expect } from 'vitest'
import { SqlCoordinatorStorage } from '../../src/adapters/node/coordinator-storage.js'
import type { CoordinatorDatabase } from '../../src/coordination/database.js'
import { DurableScheduler } from '../../src/coordination/scheduler.js'

/** Real database fencing contract shared by SQLite, PostgreSQL, and MariaDB. */
export const schedulerContract = async (database: CoordinatorDatabase) => {
  await SqlCoordinatorStorage.initialize(database)
  await SqlCoordinatorStorage.initialize(database)
  const alarm = new SqlCoordinatorStorage(database, 'fencing-contract')
  await alarm.setAlarm(1)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const delivered: string[] = []
  const first = new DurableScheduler(database, async (actor) => {
    delivered.push(`first:${actor}`)
    entered.resolve()
    await release.promise
  })
  const second = new DurableScheduler(database, async (actor) => {
    delivered.push(`second:${actor}`)
    await alarm.setAlarm(3)
  })
  const pending = first.tick(1)
  try {
    await entered.promise
    // A skewed process clock cannot expire a lease maintained on the database clock.
    await second.tick(Number.MAX_SAFE_INTEGER)
    expect(delivered).toEqual(['first:fencing-contract'])
    // Simulate the crashed owner's persisted lease expiring without a wall-clock sleep.
    await database.run('UPDATE runtime_alarms SET claimed_until = 0 WHERE actor = ?1', alarm.actor)
    await second.tick(1)
    expect(delivered).toEqual(['first:fencing-contract', 'second:fencing-contract'])
    expect(await alarm.getAlarm()).toBe(3)
  } finally {
    release.resolve()
    await pending
    await Promise.all([first.stop(), second.stop()])
  }
  // The stale owner's completion cannot delete the replacement generation.
  expect(await alarm.getAlarm()).toBe(3)
  const final = new DurableScheduler(database, async (actor) => {
    delivered.push(`final:${actor}`)
  })
  await final.tick(2)
  expect(await alarm.getAlarm()).toBe(3)
  await final.tick(3)
  expect(await alarm.getAlarm()).toBeNull()
  await final.stop()
}
