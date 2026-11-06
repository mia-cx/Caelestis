import { type PresenceServerEvent, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { coordinatorDatabase } from '../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../src/adapters/node/coordinator-storage.js'
import { PresenceCoordinator, type PresenceHost } from '../src/presence-coordinator.js'
import type { LiveSocket } from '../src/status-coordinator.js'
import { openRelationalStore } from './support/relational.js'

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

it('selects peers from presence updates that arrive while claims renew', async () => {
  const store = await openRelationalStore()
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
  const coordinator = new PresenceCoordinator(host, store.sql)
  coordinator.stop()
  try {
    await coordinator.alarm()
    expect(observer.events.at(-1)).toMatchObject({
      type: 'presence-ready',
      peers: [{ sessionId: '0000000000000002' }],
    })

    // The observer's hourly renewal is due; the mover leaves while the renewal is in flight.
    observer.serializeAttachment({ ...(observer.deserializeAttachment() as object), renewedAt: 0 })
    const renew = store.sql.regions.renewRegions.bind(store.sql.regions)
    store.sql.regions.renewRegions = async (owners, now) => {
      coordinator.webSocketMessage(
        mover,
        JSON.stringify({
          type: 'presence-update',
          viewport: { x: 100_000, y: 100_000, w: 800, h: 800 },
        }),
      )
      await renew(owners, now)
    }
    await coordinator.alarm()
    expect(observer.events.at(-1)).toMatchObject({
      type: 'presence-delta',
      upsert: [],
      remove: ['0000000000000002'],
    })
  } finally {
    await store.close()
  }
})
