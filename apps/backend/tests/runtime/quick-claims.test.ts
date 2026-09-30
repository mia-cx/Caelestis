import { on, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PRESENCE_PROTOCOL_V1,
  PRESENCE_STALE_MS,
  type PresencePeer,
  type PresenceServerEvent,
  type PresenceUpdate,
  uuidV7,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { FilesystemObjectStorage } from '@caelestis/storage/filesystem'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { readNodeConfig } from '../../src/node/config.js'
import { openNodeRuntime } from '../../src/node/runtime.js'
import { listenNodeServer } from '../../src/node/server.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

const viewport = { x: 8_000, y: 8_000, w: 128, h: 128 }
const quickClaims = [
  { x: 8_003, y: 8_005, w: 17, h: 19 },
  { x: 8_031, y: 8_037, w: 23, h: 29 },
]
const peers = (event: PresenceServerEvent): readonly PresencePeer[] =>
  event.type === 'presence-ready'
    ? event.peers
    : event.type === 'presence-delta'
      ? event.upsert
      : []

const start = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caelestis-quick-claims-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const config = readNodeConfig({
    DATA_DIRECTORY: directory,
    PORT: '0',
    HOST: '127.0.0.1',
    ADMIN_TOKEN: 'runtime-admin',
    OPEN_ACCESS: 'true',
  })
  const runtime = await openNodeRuntime(
    config,
    new FilesystemObjectStorage(join(directory, 'objects')),
    { onOwnershipLost() {} },
  )
  cleanups.push(() => runtime.close())
  const server = await listenNodeServer(runtime, config)
  cleanups.push(() => server.close())
  const base = `http://127.0.0.1:${server.port}/backend/v1`
  const minted = await fetch(`${base}/admin/tokens`, {
    method: 'POST',
    headers: { authorization: 'Bearer runtime-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'quick claims reporter', scope: 'report' }),
  })
  expect(minted.status).toBe(201)
  const { token: reportToken } = (await minted.json()) as { token: string }

  const connect = async (token: string | null = reportToken, displayName = 'Painter') => {
    const query = new URLSearchParams({
      season: '0',
      painterId: '123456789',
      painterName: displayName,
      clientId: uuidV7(),
      publisherId: uuidV7(),
    })
    const socket = new WebSocket(`${base.replace('http', 'ws')}/telemetry/presence?${query}`, [
      PRESENCE_PROTOCOL_V1,
      ...(token === null ? [] : [`caelestis.auth.b64.${Buffer.from(token).toString('base64url')}`]),
    ])
    const events: PresenceServerEvent[] = []
    socket.on('message', (data) => {
      if (String(data) !== 'pong') events.push(JSON.parse(String(data)))
    })
    const ready = once(socket, 'message')
    await once(socket, 'open')
    const event = JSON.parse(String((await ready)[0])) as PresenceServerEvent
    if (event.type !== 'presence-ready') throw new Error('Expected presence-ready')
    return {
      socket,
      sessionId: event.sessionId,
      canWrite: event.canWrite,
      events,
      update: (update: Omit<PresenceUpdate, 'type'>) =>
        socket.send(JSON.stringify({ type: 'presence-update', ...update })),
      // Frames on one socket are ordered. Pong proves the preceding update was handled.
      async processed() {
        const messages = on(socket, 'message', { signal: AbortSignal.timeout(1_000) })
        socket.send('ping')
        for await (const [data] of messages) if (String(data) === 'pong') break
      },
    }
  }
  return { connect, readToken: runtime.readToken }
}

type Painter = Awaited<ReturnType<Awaited<ReturnType<typeof start>>['connect']>>
const waitForPeer = async (subscriber: Painter, sessionId: string) => {
  let peer: PresencePeer | undefined
  await vi.waitFor(() => {
    peer = subscriber.events.flatMap(peers).find((candidate) => candidate.sessionId === sessionId)
    expect(peer).toBeDefined()
  })
  if (peer === undefined) throw new Error('Expected peer')
  return peer
}

const publishingPair = async () => {
  const { connect } = await start()
  const a = await connect()
  const b = await connect()
  b.update({ viewport })
  a.update({ viewport, quickClaims })
  expect((await waitForPeer(b, a.sessionId)).quickClaims).toEqual(quickClaims)
  b.events.length = 0
  return { a, b }
}

it('publishes two exact quick claims to an overlapping painter', async () => {
  await publishingPair()
})

it('omits quickClaims from the next peer update after an explicit clear', async () => {
  const { a, b } = await publishingPair()
  a.update({ quickClaims: [] })
  expect(await waitForPeer(b, a.sessionId)).not.toHaveProperty('quickClaims')
})

it('preserves quick claims when an update omits them', async () => {
  const { a, b } = await publishingPair()
  a.update({ draft: { rect: viewport, pixels: 1 } })
  expect((await waitForPeer(b, a.sessionId)).quickClaims).toEqual(quickClaims)
})

it('replaces the complete quick-claim list', async () => {
  const { a, b } = await publishingPair()
  const replacement = [{ x: 8_051, y: 8_059, w: 7, h: 11 }]
  a.update({ quickClaims: replacement })
  expect((await waitForPeer(b, a.sessionId)).quickClaims).toEqual(replacement)
})

it('removes a disconnected painter holding quick claims', async () => {
  const { a, b } = await publishingPair()
  a.socket.close()
  await vi.waitFor(() =>
    expect(b.events).toContainEqual(
      expect.objectContaining({ type: 'presence-delta', remove: [a.sessionId] }),
    ),
  )
})

it('removes stale quick claims while the observing painter stays online', async () => {
  const { a, b } = await publishingPair()
  const now = Date.now() + PRESENCE_STALE_MS
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const closed = once(a.socket, 'close')
  b.socket.send(JSON.stringify({ type: 'presence-heartbeat' }))
  expect((await closed).slice(0, 2).map(String)).toEqual(['1000', 'presence stale'])
  await vi.waitFor(() =>
    expect(b.events).toContainEqual(
      expect.objectContaining({ type: 'presence-delta', online: 1, remove: [a.sessionId] }),
    ),
  )
})

it('includes a peer whose quick claim alone intersects the padded interest', async () => {
  const { connect } = await start()
  const a = await connect()
  const b = await connect()
  const near = [{ x: viewport.x - 500, y: viewport.y, w: 7, h: 11 }]
  b.update({ viewport })
  a.update({ viewport: { ...viewport, x: 100_000, y: 100_000 }, quickClaims: near })
  expect((await waitForPeer(b, a.sessionId)).quickClaims).toEqual(near)
})

it.each(['anonymous', 'read'] as const)('ignores %s quick claims', async (scope) => {
  const { connect, readToken } = await start()
  const a = await connect(scope === 'anonymous' ? null : readToken)
  expect(a.canWrite).toBe(false)
  a.update({ viewport, quickClaims })
  await a.processed()
  const b = await connect()
  const witness = await connect()
  b.update({ viewport })
  witness.update({ viewport })
  // The witness proves B received a tick after A's input, including any newly relevant peers.
  await waitForPeer(b, witness.sessionId)
  const published = b.events.flatMap(peers).find((peer) => peer.sessionId === a.sessionId)
  expect(published).toBeUndefined()
})

it('ignores the whole update when one quick claim crosses the world boundary', async () => {
  const { connect } = await start()
  const a = await connect()
  a.update({ viewport, quickClaims })
  await a.processed()
  a.update({
    viewport: { ...viewport, x: 100_000 },
    quickClaims: [...quickClaims, { x: WORLD_PIXELS - 1, y: 0, w: 2, h: 1 }],
  })
  await a.processed()
  const b = await connect()
  b.update({ viewport })
  expect(await waitForPeer(b, a.sessionId)).toMatchObject({ viewport, quickClaims })
})
