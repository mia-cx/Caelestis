import { encodeIndexedPng, uuidV7, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../src/adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../src/adapters/memory/memory-counter-store.js'
import { coordinatorDatabase } from '../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../src/adapters/node/coordinator-storage.js'
import { type LiveHost, type LiveSocket, StatusCoordinator } from '../src/status-coordinator.js'
import { authorized, createTestBackend } from './support/backend.js'
import { openRelationalStore } from './support/relational.js'

const SEASON = 3

/** A socket that records every message the coordinator sends it. */
class RecordingSocket implements LiveSocket {
  readonly sent: string[] = []
  constructor(private attachment: unknown) {}
  send(message: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(String(message))
  }
  close(): void {}
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

const opened: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of opened.splice(0)) await close()
})

const liveCoordinator = async () => {
  const store = await openRelationalStore()
  opened.push(store.close)
  const { app } = await createTestBackend({ sql: store.sql })
  const form = new FormData()
  form.set('png', new File([await encodeIndexedPng(1, 1, new Uint8Array([1]))], 'art.png'))
  form.set('name', 'Broadcast')
  form.set('season', String(SEASON))
  form.set('originX', '10')
  form.set('originY', '20')
  const created = await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))
  const { templateId } = (await created.json()) as { templateId: string }

  const database = coordinatorDatabase(store.connection)
  await SqlCoordinatorStorage.initialize(database)
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
    new MemoryBlobStore(),
    () => new MemoryCounterStore(store.sql),
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

it('acknowledges dashboard changes at once and serves a burst with one shared read per refresh', async () => {
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
  const reads = vi.spyOn(sql, 'readContributions')

  await Promise.all(Array.from({ length: 5 }, () => coordinator.notifyDashboardChange(SEASON)))
  for (const socket of sockets) expect(socket.events('dashboard-snapshot')).toHaveLength(1)

  // The first change starts a refresh; the four that land during it share exactly one more.
  await vi.waitFor(() => {
    for (const socket of sockets) expect(socket.events('dashboard-snapshot')).toHaveLength(3)
  })
  for (const [index, socket] of sockets.entries())
    expect(socket.events('dashboard-snapshot')).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({ subscriptionId: subscriptionIds[index] }),
      ),
    )
  // Contributions and the leaderboard both read contributions: two reads per shared refresh.
  expect(reads).toHaveBeenCalledTimes(4)
})
