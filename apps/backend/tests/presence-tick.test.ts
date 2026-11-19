import { millis, type PresenceServerEvent, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { coordinatorDatabase } from '../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../src/adapters/node/coordinator-storage.js'
import type { LiveSocket } from '../src/live/session.js'
import { openMemoryDatabase } from '../src/node/memory-stores.js'
import { PresenceCoordinator, type PresenceHost } from '../src/presence/coordinator.js'
import { IngestTimings } from '../src/telemetry/ingest-timing.js'

class Socket implements LiveSocket {
  readyState = 1
  readonly events: PresenceServerEvent[] = []
  constructor(private attachment: unknown) {}
  send(message: string | ArrayBuffer | ArrayBufferView) {
    if (typeof message === 'string' && message !== 'pong') this.events.push(JSON.parse(message))
  }
  close() {
    this.readyState = 3
  }
  serializeAttachment(attachment: unknown) {
    this.attachment = structuredClone(attachment)
  }
  deserializeAttachment() {
    return structuredClone(this.attachment)
  }
}

const session = (index: number, viewport: { x: number; y: number }, renewedAt: number) =>
  new Socket({
    sessionId: String(index).padStart(16, '0'),
    season: 0,
    surface: WORLD_TEMPLATE_SURFACE,
    painter: { wplaceUserId: index, displayName: `Painter ${index}` },
    tokenHash: String(index).padStart(64, '0'),
    clientHash: String(index).padStart(64, '0'),
    credentialScope: 'report',
    anonymous: false,
    revocable: false,
    metricClient: 'frontend',
    metricClientVersion: 'development',
    viewport: { ...viewport, w: 800, h: 800 },
    draftRect: null,
    draftPixels: 0,
    lastSeenAt: Date.now(),
    renewedAt,
  })

for (const renewing of ['observer', 'mover'] as const)
  it(`keeps a presence update that arrives while the ${renewing}'s claims renew`, async () => {
    const store = openMemoryDatabase()
    const database = coordinatorDatabase(store.connection)
    await SqlCoordinatorStorage.initialize(database)
    const observer = session(1, { x: 0, y: 0 }, Date.now())
    const mover = session(2, { x: 400, y: 400 }, Date.now())
    const sockets = [observer, mover]
    const host: PresenceHost<unknown> = {
      storage: new SqlCoordinatorStorage(database, 'presence'),
      getWebSockets: () => sockets,
      connect: () => {
        throw new Error('unused')
      },
      upgradeResponse: () => new Response(null),
      waitUntil: () => {},
    }
    const coordinator = new PresenceCoordinator(
      host,
      { season: 0, surface: WORLD_TEMPLATE_SURFACE },
      store.sql,
      new IngestTimings(),
      async () => {},
    )
    coordinator.stop()
    try {
      await coordinator.alarm()
      expect(observer.events.at(-1)).toMatchObject({
        type: 'presence-ready',
        peers: [{ sessionId: '0000000000000002' }],
      })

      // An hourly renewal is due; the mover leaves while it is in flight.
      const due = renewing === 'observer' ? observer : mover
      due.serializeAttachment({ ...(due.deserializeAttachment() as object), renewedAt: 0 })
      const away = { x: 100_000, y: 100_000, w: 800, h: 800 }
      const renew = store.sql.regions.renewRegions.bind(store.sql.regions)
      store.sql.regions.renewRegions = async (owners, now) => {
        coordinator.webSocketMessage(
          mover,
          JSON.stringify({ type: 'presence-update', viewport: away }),
        )
        await renew(owners, now)
      }
      await coordinator.alarm()
      expect(observer.events.at(-1)).toMatchObject({
        type: 'presence-delta',
        upsert: [],
        remove: ['0000000000000002'],
      })
      expect(mover.deserializeAttachment()).toMatchObject({ viewport: away })
      expect((due.deserializeAttachment() as { renewedAt: number }).renewedAt).toBeGreaterThan(0)
    } finally {
      await store.close()
    }
  })

/** A room over `sockets`, with every credential it routes revocation to recorded in `routed`. */
const openRoom = async (sockets: Socket[]) => {
  const store = openMemoryDatabase()
  const database = coordinatorDatabase(store.connection)
  await SqlCoordinatorStorage.initialize(database)
  const routed: string[] = []
  const host: PresenceHost<Socket> = {
    storage: new SqlCoordinatorStorage(database, 'presence'),
    getWebSockets: () => sockets,
    connect: (attachment) => {
      const socket = new Socket(attachment)
      sockets.push(socket)
      return { client: socket, server: socket }
    },
    upgradeResponse: () => new Response(null),
    waitUntil: () => {},
  }
  const coordinator = new PresenceCoordinator(
    host,
    { season: 0, surface: WORLD_TEMPLATE_SURFACE },
    store.sql,
    new IngestTimings(),
    async (tokenHash) => {
      routed.push(tokenHash)
    },
  )
  coordinator.stop()
  return { store, coordinator, routed }
}

it('serves the room around a socket whose attachment an earlier deploy wrote', async () => {
  const observer = session(1, { x: 0, y: 0 }, Date.now())
  const { store, coordinator } = await openRoom([new Socket({ sessionId: 'legacy' }), observer])
  try {
    await coordinator.alarm()
    expect(observer.events.at(-1)).toMatchObject({ type: 'presence-ready', online: 1 })
  } finally {
    await store.close()
  }
})

it('routes revocation only to a room that admitted the credential', async () => {
  const client = '9'.repeat(64)
  const full = Array.from({ length: 4 }, (_, index) => {
    const socket = session(index + 1, { x: 0, y: 0 }, Date.now())
    socket.serializeAttachment({
      ...(socket.deserializeAttachment() as object),
      clientHash: client,
    })
    return socket
  })
  const { store, coordinator, routed } = await openRoom(full)
  const tokenHash = 'a'.repeat(64)
  await store.sql.insertAccessToken({
    tokenHash,
    label: 'reporter',
    scope: 'report',
    createdWithToken: tokenHash,
    createdAt: millis(Date.now()),
  })
  const connection = {
    season: 0,
    surface: WORLD_TEMPLATE_SURFACE,
    painter: { wplaceUserId: 7, displayName: 'Painter 7' },
    tokenHash,
    credentialScope: 'report',
    anonymous: false,
    revocable: true,
    metricClient: 'frontend',
    metricClientVersion: 'development',
  } as const
  try {
    expect((await coordinator.connect({ ...connection, clientHash: client })).status).toBe(503)
    expect(routed).toEqual([])
    expect((await coordinator.connect({ ...connection, clientHash: 'b'.repeat(64) })).ok).toBe(true)
    expect(routed).toEqual([tokenHash])
  } finally {
    await store.close()
  }
})
