import {
  encodeIndexedPng,
  encodeLiveTileUpload,
  seconds,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import { coordinatorDatabase } from '../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../src/adapters/node/coordinator-storage.js'
import type { LiveHost, LiveSocket } from '../src/live/session.js'
import { StatusCoordinator } from '../src/status-coordinator.js'
import { authorized, createTestBackend } from './support/backend.js'

const SEASON = 3

/** A socket that records every message the coordinator sends it. */
class RecordingSocket implements LiveSocket {
  readonly sent: string[] = []
  closed: { code: number | undefined; reason: string | undefined } | null = null
  constructor(private attachment: unknown) {}
  send(message: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(String(message))
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment
  }
  deserializeAttachment(): unknown {
    return this.attachment
  }
  events(type: string): unknown[] {
    return this.sent
      .map((message) => JSON.parse(message) as { type: string })
      .filter((event) => event.type === type)
  }
}

const liveCoordinator = async () => {
  const store = await createTestBackend()
  const { app } = store
  const form = new FormData()
  form.set('png', new File([await encodeIndexedPng(1, 1, new Uint8Array([1]))], 'art.png'))
  form.set('name', 'Broadcast')
  form.set('season', String(SEASON))
  form.set('originX', '10')
  form.set('originY', '20')
  const created = await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))
  const { templateId } = (await created.json()) as { templateId: string }

  const database = coordinatorDatabase(store.connection)
  const sockets: RecordingSocket[] = []
  const host: LiveHost<LiveSocket> = {
    storage: new SqlCoordinatorStorage(database, `season:${SEASON}`),
    getWebSockets: () => sockets,
    connect: (attachment) => {
      const socket = new RecordingSocket(attachment)
      sockets.push(socket)
      return { client: socket, server: socket }
    },
    upgradeResponse: () => new Response(null),
  }
  const coordinator = new StatusCoordinator(
    host,
    store.sql,
    store.blobs,
    () => store.counters,
    { id: '00000000-0000-7000-8000-000000000000', name: 'Test server', auth: 'access_token' },
    async () => {},
    async () => {},
  )
  const subscribe = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      const { server } = host.connect({
        season: SEASON,
        scope: 'admin',
        credentialScope: 'admin',
        tokenHash: index.toString(16).padStart(64, '0'),
        revocable: false,
        lastRevision: null,
        protocol: 2,
        projections: [
          { resource: 'world-manifest', scope: 'world', version: null },
          { resource: 'telemetry-alarms', scope: 'world', version: null },
        ],
      })
      return server as RecordingSocket
    })
  return { coordinator, sql: store.sql, templateId, subscribe }
}

it('sends alarm snapshots only for template changes, never for metadata-only manifest edits', async () => {
  const { coordinator, subscribe } = await liveCoordinator()
  const sockets = subscribe(3)

  await coordinator.notifyManifestChange(SEASON, WORLD_TEMPLATE_SURFACE, false)
  for (const socket of sockets) {
    expect(socket.events('manifest-reconcile')).toHaveLength(1)
    expect(socket.events('manifest-snapshot')).toHaveLength(1)
    expect(socket.events('alarms-snapshot')).toHaveLength(0)
  }
  // Every subscriber in one audience receives the same bytes.
  expect(new Set(sockets.map((socket) => socket.sent.join('\n'))).size).toBe(1)

  await coordinator.notifyManifestChange(SEASON, WORLD_TEMPLATE_SURFACE)
  for (const socket of sockets) expect(socket.events('alarms-snapshot')).toHaveLength(1)
})

it('acknowledges dashboard changes before refreshing and serves a burst with one shared read', async () => {
  const { coordinator, sql, templateId, subscribe } = await liveCoordinator()
  const sockets = subscribe(3)
  const subscriptionIds = sockets.map(() => uuidV7())
  for (const [index, socket] of sockets.entries()) {
    await coordinator.webSocketMessage(
      socket,
      JSON.stringify({
        type: 'dashboard-subscribe',
        requestId: uuidV7(),
        subscription: {
          subscriptionId: subscriptionIds[index],
          templateIds: [templateId],
          contributionsFrom: Math.floor(Date.now() / 1000) - 86_400,
          leaderboardLimit: 10,
        },
      }),
    )
    expect(socket.events('dashboard-snapshot')).toHaveLength(1)
  }
  const contributionReads = vi.spyOn(sql, 'readContributions')
  const leaderboardReads = vi.spyOn(sql, 'readLeaderboard')

  await Promise.all(Array.from({ length: 5 }, () => coordinator.notifyDashboardChange(SEASON)))
  // Nothing has read yet: the paint that notified is acknowledged before its refresh starts.
  expect(contributionReads).not.toHaveBeenCalled()
  expect(leaderboardReads).not.toHaveBeenCalled()
  for (const socket of sockets) expect(socket.events('dashboard-snapshot')).toHaveLength(1)

  // The burst shares one refresh, and every subscription gets its own snapshot from it.
  await vi.waitFor(() => {
    for (const socket of sockets) expect(socket.events('dashboard-snapshot')).toHaveLength(2)
  })
  // One read of each for the whole burst, shared by every subscriber.
  expect(contributionReads).toHaveBeenCalledTimes(1)
  expect(leaderboardReads).toHaveBeenCalledTimes(1)

  // A later change still reaches every subscriber.
  await coordinator.notifyDashboardChange(SEASON)
  await vi.waitFor(() => {
    for (const socket of sockets) expect(socket.events('dashboard-snapshot')).toHaveLength(3)
  })
  for (const [index, socket] of sockets.entries())
    expect(socket.events('dashboard-snapshot')).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({ subscriptionId: subscriptionIds[index] }),
      ),
    )
})

it('answers an upload whose bytes do not match their hash as invalid, not unavailable', async () => {
  const { coordinator, subscribe } = await liveCoordinator()
  const [socket] = subscribe(1)
  if (socket === undefined) throw new Error('Expected a subscriber')
  const requestId = uuidV7()
  const deliveryId = uuidV7()
  const frame = encodeLiveTileUpload(
    {
      type: 'tile-upload',
      requestId,
      deliveryId,
      season: SEASON,
      tile: '0/0',
      sha256: '0'.repeat(64),
      ts: seconds(Math.floor(Date.now() / 1_000)),
      wplaceUserId: 1,
      displayName: 'Reporter',
    },
    await encodeIndexedPng(1, 1, new Uint8Array([1])),
  )

  await coordinator.webSocketMessage(socket, frame.buffer)

  expect(socket.closed).toBeNull()
  expect(socket.events('tile-upload-result')).toEqual([
    { type: 'tile-upload-result', requestId, deliveryId, accepted: false, error: 'invalid' },
  ])
})
