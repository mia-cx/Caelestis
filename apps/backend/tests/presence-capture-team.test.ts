import {
  type CaptureRun,
  type PresenceServerEvent,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import { coordinatorDatabase } from '../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../src/adapters/node/coordinator-storage.js'
import { IngestTimings } from '../src/metrics/ingest-timing.js'
import {
  type LiveTransportSocket,
  type LiveUpgradeContext,
  liveRequestContext,
  NodeLiveHost,
} from '../src/node/live.js'
import { openMemoryDatabase } from '../src/node/memory-stores.js'
import { PresenceCoordinator } from '../src/presence/coordinator.js'

const GREEN = 2
const ORANGE = 1

/** Storage whose read of Green's capture lobbies waits until the test releases it. */
class GatedStorage extends SqlCoordinatorStorage {
  release: () => void = () => {}
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  override async get<T>(key: string): Promise<T | undefined> {
    if (key === `capture-runs:${GREEN}`) await this.gate
    return super.get<T>(key)
  }
}

it('sends the lobbies of the team a session switched to, never a late read of the one it left', async () => {
  const store = openMemoryDatabase()
  const database = coordinatorDatabase(store.connection)
  await SqlCoordinatorStorage.initialize(database)
  const storage = new GatedStorage(database, 'presence')
  const host = new NodeLiveHost(storage, () => coordinator)
  const coordinator = new PresenceCoordinator(
    host,
    { season: 0, surface: WORLD_TEMPLATE_SURFACE },
    store.sql,
    new IngestTimings(),
    async () => {},
    true,
  )
  coordinator.stop()
  const green: CaptureRun = {
    id: uuidV7(),
    team: GREEN,
    coordinator: null,
    painters: 1,
    guards: 0,
    members: [],
    wall: null,
    guardZones: [],
    startsAt: null,
    staggerMs: 500,
  }
  await storage.put(`capture-runs:${GREEN}`, [green])
  const received: PresenceServerEvent[] = []
  const transport: LiveTransportSocket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (message) => received.push(JSON.parse(String(message))),
    close: () => {},
    on: () => {},
  }
  try {
    const context: LiveUpgradeContext = {}
    await liveRequestContext.run(context, () =>
      coordinator.connect({
        season: 0,
        surface: WORLD_TEMPLATE_SURFACE,
        painter: { wplaceUserId: 1, displayName: 'Painter' },
        tokenHash: 'a'.repeat(64),
        clientHash: 'b'.repeat(64),
        credentialScope: 'report',
        anonymous: false,
        revocable: false,
        metricClient: 'userscript',
        metricClientVersion: 'development',
      }),
    )
    context.accept?.(transport)
    const socket = host.getWebSockets()[0]
    if (socket === undefined) throw new Error('Expected connected presence socket')
    const update = (team: number) =>
      coordinator.webSocketMessage(socket, JSON.stringify({ type: 'presence-update', team }))

    // Green's read stalls; the session then reports Orange, whose read answers at once.
    update(GREEN)
    update(ORANGE)
    const lobbies = () => received.filter((e) => e.type === 'capture-runs')
    await vi.waitFor(() => expect(lobbies()).toHaveLength(1))
    storage.release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lobbies()).toEqual([{ type: 'capture-runs', runs: [] }])
  } finally {
    await host.close()
    await store.close()
  }
})
