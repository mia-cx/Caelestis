import { expect, it, vi } from 'vitest'
import { coordinatorDatabase } from '../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../src/adapters/node/coordinator-storage.js'
import { DurableScheduler } from '../src/coordination/scheduler.js'
import { openRelationalStore } from './support/relational.js'
import { schedulerContract } from './support/scheduler-contract.js'

it('fences concurrent schedulers and preserves replacement alarms in SQLite', async () => {
  const opened = await openRelationalStore()
  try {
    await schedulerContract(coordinatorDatabase(opened.connection))
  } finally {
    await opened.close()
  }
})

it('upgrades persisted v1 jobs and retries a failed handler without losing its alarm', async () => {
  const opened = await openRelationalStore()
  const database = coordinatorDatabase(opened.connection)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const now = vi.spyOn(Date, 'now').mockReturnValue(100)
  try {
    await database.run(
      'CREATE TABLE runtime_alarms (actor TEXT PRIMARY KEY, due_at BIGINT NOT NULL, generation TEXT NOT NULL)',
    )
    await database.run("INSERT INTO runtime_alarms VALUES ('legacy', 1, 'original')")
    await SqlCoordinatorStorage.initialize(database)
    const alarm = new SqlCoordinatorStorage(database, 'legacy')
    let attempts = 0
    const scheduler = new DurableScheduler(database, async () => {
      if (++attempts === 1) throw new Error('transient failure')
    })
    await scheduler.tick(1)
    expect(await alarm.getAlarm()).toBe(1100)
    await scheduler.tick(1099)
    expect(attempts).toBe(1)
    await scheduler.tick(1100)
    expect(attempts).toBe(2)
    expect(await alarm.getAlarm()).toBeNull()
    expect(error).toHaveBeenCalledWith('Durable job failed: legacy', expect.any(Error))
    await scheduler.stop()
  } finally {
    now.mockRestore()
    error.mockRestore()
    await opened.close()
  }
})
