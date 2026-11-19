import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemObjectStorage } from '@caelestis/storage/filesystem'
import { afterEach, expect, it, vi } from 'vitest'
import { coordinatorDatabase } from '../../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../../src/adapters/node/coordinator-storage.js'
import { readNodeConfig } from '../../src/node/config.js'
import { openNodeRuntime } from '../../src/node/runtime.js'
import { listenNodeServer } from '../../src/node/server.js'

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

it('renders share images through the port the listener bound, not the configured 0', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-wakeups-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const config = readNodeConfig({ DATA_DIRECTORY: directory, PORT: '0', HOST: '127.0.0.1' })
  let rendered: (api: string) => void = () => {}
  const api = new Promise<string>((resolve) => {
    rendered = resolve
  })
  const runtime = await openNodeRuntime(
    config,
    new FilesystemObjectStorage(join(directory, 'objects')),
    { onOwnershipLost() {}, refreshSocial: async (url) => rendered(url) },
  )
  cleanups.push(() => runtime.close())
  // Overdue before the listener starts, so the first scheduler poll runs it.
  await new SqlCoordinatorStorage(coordinatorDatabase(runtime.connection), 'social').setAlarm(
    Date.now() - 1,
  )

  const server = await listenNodeServer(runtime, config)
  cleanups.push(() => server.close())

  expect(await api).toBe(`http://127.0.0.1:${server.port}/backend/v1/`)
})
