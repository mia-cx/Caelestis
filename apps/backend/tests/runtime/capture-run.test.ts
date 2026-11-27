import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPTURE_LEAD_MS,
  type CaptureClientEvent,
  type CaptureRun,
  PRESENCE_PROTOCOL_V1,
  type PresenceServerEvent,
  uuidV7,
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
})

const ADMIN = 'capture-admin'

/** A server on a fresh data directory, or on `directory` to restart one that ran before. */
const start = async ({ eventServer = true, directory = '' } = {}) => {
  if (directory === '') {
    directory = await mkdtemp(join(tmpdir(), 'caelestis-capture-'))
    const made = directory
    cleanups.push(() => rm(made, { recursive: true, force: true }))
  }
  const config = readNodeConfig({
    DATA_DIRECTORY: directory,
    PORT: '0',
    HOST: '127.0.0.1',
    ADMIN_TOKEN: ADMIN,
    EVENT_SERVER: String(eventServer),
  })
  const runtime = await openNodeRuntime(
    config,
    new FilesystemObjectStorage(join(directory, 'objects')),
    { onOwnershipLost() {} },
  )
  const server = await listenNodeServer(runtime, config)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await server.close()
    await runtime.close()
  }
  cleanups.push(stop)
  const base = `http://127.0.0.1:${server.port}/backend/v1`
  const minted = await fetch(`${base}/admin/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'painter', scope: 'report' }),
  })
  const { token: painterToken } = (await minted.json()) as { token: string }

  let nextPainter = 1
  const connect = async (token: string) => {
    const painterId = nextPainter++
    const query = new URLSearchParams({
      season: '0',
      painterId: String(painterId),
      painterName: `Painter ${painterId}`,
      clientId: uuidV7(),
    })
    const socket = new WebSocket(`${base.replace('http', 'ws')}/telemetry/presence?${query}`, [
      PRESENCE_PROTOCOL_V1,
      `caelestis.auth.b64.${Buffer.from(token).toString('base64url')}`,
    ])
    cleanups.push(async () => socket.close())
    const events: PresenceServerEvent[] = []
    socket.on('message', (data) => {
      if (String(data) !== 'pong') events.push(JSON.parse(String(data)))
    })
    const ready = once(socket, 'message')
    await once(socket, 'open')
    const event = JSON.parse(String((await ready)[0])) as PresenceServerEvent
    if (event.type !== 'presence-ready') throw new Error('Expected presence-ready')
    return {
      sessionId: event.sessionId,
      events,
      send: (message: CaptureClientEvent) => socket.send(JSON.stringify(message)),
      close: () => socket.close(),
      /** The run as this socket last heard it. */
      run(): CaptureRun | null | undefined {
        const last = events.filter((e) => e.type === 'capture').at(-1)
        return last?.type === 'capture' ? last.run : undefined
      },
    }
  }
  return {
    base,
    directory,
    stop,
    admin: () => connect(ADMIN),
    painter: () => connect(painterToken),
  }
}

const line = (y: number) => [636_000, y, 636_001, y]

it('runs no capture runs on a server that is not an event server', async () => {
  const server = await start({ eventServer: false })
  const info = await (
    await fetch(`${server.base}/server`, { headers: { authorization: `Bearer ${ADMIN}` } })
  ).json()
  expect(info).not.toHaveProperty('capture')
  const admin = await server.admin()
  admin.send({ type: 'capture-open', painters: 1, guards: 0, team: 2 })
  admin.send({ type: 'clock', sent: 1 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(
    admin.events.filter((event) => event.type === 'capture' || event.type === 'clock'),
  ).toEqual([])
})

it('keeps a run saved as an event server from clients once it is not one', async () => {
  const before = await start()
  const admin = await before.admin()
  admin.send({ type: 'capture-open', painters: 1, guards: 0, team: 2 })
  await vi.waitFor(() => expect(admin.run()).not.toBeNull())
  admin.close()
  await before.stop()

  const after = await start({ eventServer: false, directory: before.directory })
  const painter = await after.painter()
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(painter.events.filter((event) => event.type === 'capture')).toEqual([])
})

it('runs a capture from open to start, in the order the administrator sets', async () => {
  const server = await start()
  const admin = await server.admin()
  const first = await server.painter()
  const second = await server.painter()

  first.send({ type: 'capture-open', painters: 1, guards: 1, team: 2 })
  admin.send({ type: 'capture-open', painters: 1, guards: 1, team: 2 })
  await vi.waitFor(() => expect(first.run()).toMatchObject({ team: 2, painters: 1, guards: 1 }))

  // A painter from another team cannot take a place in Green's wall.
  const orange = await server.painter()
  const id = first.run()?.id ?? ''
  orange.send({ type: 'capture-join', team: 1, run: id })
  first.send({ type: 'capture-join', team: 2, run: id })
  second.send({ type: 'capture-join', team: 2, run: id })
  // Opening again does not replace a run in progress.
  admin.send({ type: 'capture-open', painters: 3, guards: 0, team: 2 })
  await vi.waitFor(() => expect(admin.run()?.members).toHaveLength(2))
  expect(admin.run()).toMatchObject({ id, painters: 1 })
  expect(admin.run()?.members.map((m) => m.sessionId)).not.toContain(orange.sessionId)
  admin.send({ type: 'capture-order', order: [second.sessionId, first.sessionId] })
  admin.send({ type: 'capture-plan', lines: [line(1_028_000), line(1_028_001)] })
  second.send({ type: 'capture-drafted', drafted: 2 })
  await vi.waitFor(() =>
    expect(first.run()?.members.map((m) => [m.sessionId, m.drafted])).toEqual([
      [second.sessionId, 2],
      [first.sessionId, 0],
    ]),
  )

  const before = Date.now()
  first.send({ type: 'capture-go' })
  admin.send({ type: 'capture-go' })
  await vi.waitFor(() => expect(second.run()?.startsAt).not.toBeNull())
  const startsAt = second.run()?.startsAt ?? 0
  expect(startsAt - before).toBeGreaterThanOrEqual(CAPTURE_LEAD_MS - 1_000)

  // A late joiner hears the started run, and cannot join it.
  const late = await server.painter()
  await vi.waitFor(() => expect(late.run()?.startsAt).toBe(startsAt))
  late.send({ type: 'capture-join', team: 2, run: id })
  // The first painter's socket drops during the countdown; nobody moves into their slot.
  second.close()
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(admin.run()?.members.map((m) => m.sessionId)).toEqual([second.sessionId, first.sessionId])
  admin.send({ type: 'capture-order', order: [first.sessionId, second.sessionId] })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(admin.run()?.members[0]?.sessionId).toBe(second.sessionId)

  admin.send({ type: 'capture-close' })
  await vi.waitFor(() => expect(first.run()).toBeNull())
})

it('answers clock requests with the server time', async () => {
  const server = await start()
  const painter = await server.painter()
  const sent = Date.now()
  painter.send({ type: 'clock', sent })
  await vi.waitFor(() => {
    const clock = painter.events.find((e) => e.type === 'clock')
    expect(clock).toMatchObject({ type: 'clock', sent })
    if (clock?.type === 'clock') expect(Math.abs(clock.at - sent)).toBeLessThan(1_000)
  })
})
