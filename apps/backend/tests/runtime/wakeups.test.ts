import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemObjectStorage } from '@caelestis/storage/filesystem'
import { afterEach, expect, it, vi } from 'vitest'
import { coordinatorDatabase } from '../../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../../src/adapters/node/coordinator-storage.js'
import { readNodeConfig } from '../../src/node/config.js'
import { openNodeRuntime } from '../../src/node/runtime.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

it('drops a stored wakeup that no actor handles instead of retrying it forever', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-wakeups-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const runtime = await openNodeRuntime(
    readNodeConfig({ DATA_DIRECTORY: directory }),
    new FilesystemObjectStorage(join(directory, 'objects')),
    { onOwnershipLost() {} },
  )
  cleanups.push(() => runtime.close())
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const database = coordinatorDatabase(runtime.connection)
  // Status shards and the server's own state never set wakeups, so nothing can serve these.
  const orphans = ['season:0', 'server'].map((actor) => new SqlCoordinatorStorage(database, actor))
  for (const orphan of orphans) await orphan.setAlarm(Date.now() - 1)

  await runtime.scheduler.tick()

  for (const orphan of orphans) expect(await orphan.getAlarm()).toBeNull()
})
