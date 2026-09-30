import { serialize } from 'node:v8'
import { MAX_QUICK_CLAIMS, WORLD_PIXELS, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { coordinatorDatabase } from '../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../src/adapters/node/coordinator-storage.js'
import { liveRequestContext, NodeLiveHost } from '../src/node/live.js'
import { presenceRequest } from '../src/presence/port.js'
import { PresenceCoordinator } from '../src/presence-coordinator.js'
import { openRelationalStore } from './support/relational.js'

it('keeps a fully populated maximum-claim attachment below 2,048 bytes', async () => {
  const store = await openRelationalStore()
  const database = coordinatorDatabase(store.connection)
  await SqlCoordinatorStorage.initialize(database)
  const host = new NodeLiveHost(new SqlCoordinatorStorage(database, 'presence'), () => coordinator)
  const coordinator = new PresenceCoordinator(host, store.sql)
  // This tests the attachment boundary without a TCP listener or a delivery timer.
  coordinator.stop()
  try {
    await liveRequestContext.run({}, () =>
      coordinator.fetch(
        presenceRequest(
          new Request('https://backend.test', { headers: { upgrade: 'websocket' } }),
          {
            season: 0,
            surface: WORLD_TEMPLATE_SURFACE,
            // JSON escapes these to six bytes each, exceeding an ordinary Unicode name.
            painter: { wplaceUserId: 123456789, displayName: '\u0001'.repeat(128) },
            publisherId: '01890f3e-7b2c-7abc-8def-012345678901',
            tokenHash: 'a'.repeat(64),
            clientHash: 'b'.repeat(64),
            credentialScope: 'report',
            anonymous: false,
            revocable: false,
            metricClient: 'frontend',
            metricClientVersion: 'development',
          },
        ),
      ),
    )
    const socket = host.getWebSockets()[0]
    if (socket === undefined) throw new Error('Expected connected presence socket')
    const rect = { x: WORLD_PIXELS - 2_000, y: WORLD_PIXELS - 2_000, w: 2_000, h: 2_000 }
    coordinator.webSocketMessage(
      socket,
      JSON.stringify({
        type: 'presence-update',
        viewport: rect,
        draft: { rect, pixels: 4_000_000 },
        quickClaims: Array.from({ length: MAX_QUICK_CLAIMS }, () => rect),
      }),
    )
    coordinator.webSocketClose(socket, 1000, '', true)
    const attachment = socket.deserializeAttachment()
    expect(attachment).toMatchObject({
      viewport: rect,
      draftRect: rect,
      draftPixels: 4_000_000,
      quickClaims: Array.from({ length: MAX_QUICK_CLAIMS }, () => [rect.x, rect.y, rect.w, rect.h]),
      renewedAt: expect.any(Number),
      closed: true,
    })
    expect(Buffer.byteLength(JSON.stringify(attachment))).toBeLessThan(2_048)
    expect(serialize(attachment).byteLength).toBeLessThan(2_048)
  } finally {
    await host.close()
    await store.close()
  }
})
