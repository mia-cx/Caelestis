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

/** Storage whose read or write of Green's capture lobbies waits until the test releases it. */
class GatedStorage extends SqlCoordinatorStorage {
  gated: 'get' | 'put' = 'get'
  /** Whether a gated call is waiting. */
  held = false
  release: () => void = () => {}
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  override async get<T>(key: string): Promise<T | undefined> {
    if (this.gated === 'get' && key === `capture-runs:${GREEN}`) await this.hold()
    return super.get<T>(key)
  }
  override async put<T>(key: string, value: T): Promise<void> {
    if (this.gated === 'put' && key === `capture-runs:${GREEN}`) await this.hold()
    return super.put(key, value)
  }
  private async hold(): Promise<void> {
    this.held = true
    await this.gate
  }
}

/**
 * Run `body` against one presence session on a fresh coordinator whose Green lobby storage is
 * gated, with the lobby lists it received.
 */
const withSession = async (
  gated: 'get' | 'put',
  scope: 'report' | 'event_runner',
  body: (session: {
    storage: GatedStorage
    send: (event: object) => void
    lobbies: () => PresenceServerEvent[]
  }) => Promise<void>,
) => {
  const store = openMemoryDatabase()
  const database = coordinatorDatabase(store.connection)
  await SqlCoordinatorStorage.initialize(database)
  const storage = new GatedStorage(database, 'presence')
  storage.gated = gated
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
        credentialScope: scope,
        anonymous: false,
        revocable: false,
        metricClient: 'userscript',
        metricClientVersion: 'development',
      }),
    )
    context.accept?.(transport)
    const socket = host.getWebSockets()[0]
    if (socket === undefined) throw new Error('Expected connected presence socket')
    await body({
      storage,
      send: (event) => coordinator.webSocketMessage(socket, JSON.stringify(event)),
      lobbies: () => received.filter((event) => event.type === 'capture-runs'),
    })
  } finally {
    await host.close()
    await store.close()
  }
}

it('sends the lobbies of the team a session switched to, never a late read of the one it left', async () => {
  await withSession('get', 'report', async ({ storage, send, lobbies }) => {
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
      cut: 0,
    }
    await storage.put(`capture-runs:${GREEN}`, [green])
    storage.gated = 'get'

    // Green's read stalls; the session then reports Orange, whose read answers at once.
    send({ type: 'presence-update', team: GREEN })
    send({ type: 'presence-update', team: ORANGE })
    await vi.waitFor(() => expect(lobbies()).toHaveLength(1))
    storage.release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lobbies()).toEqual([{ type: 'capture-runs', runs: [] }])
  })
})

it('never sends a team’s changed lobbies to a session that left that team during the write', async () => {
  await withSession('put', 'event_runner', async ({ storage, send, lobbies }) => {
    send({ type: 'presence-update', team: GREEN })
    await vi.waitFor(() => expect(lobbies()).toHaveLength(1))
    // Opening a Green lobby stalls in its write; the session then reports Orange.
    send({ type: 'capture-new', painters: 1, guards: 0, staggerMs: 500 })
    await vi.waitFor(() => expect(storage.held).toBe(true))
    send({ type: 'presence-update', team: ORANGE })
    await vi.waitFor(() => expect(lobbies()).toHaveLength(2))
    storage.release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lobbies().map((event) => event.type === 'capture-runs' && event.runs.length)).toEqual([
      0, 0,
    ])
  })
})
