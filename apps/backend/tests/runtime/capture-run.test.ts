import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPTURE_LEAD_MS,
  type CaptureRun,
  PRESENCE_PROTOCOL_V1,
  type PresenceClientEvent,
  type PresenceServerEvent,
  type TerritoryTeam,
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
  const mint = async (scope: 'report' | 'event_runner') => {
    const minted = await fetch(`${base}/admin/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: scope, scope }),
    })
    return ((await minted.json()) as { token: string }).token
  }
  const painterToken = await mint('report')
  const exchanged = await fetch(`${base}/auth/exchange`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await mint('event_runner')}` },
  })
  const { token: runnerToken } = (await exchanged.json()) as { token: string }

  let nextPainter = 1
  /** A session, which reports `team` as its event team first when given one. */
  const connect = async (token: string, team?: TerritoryTeam) => {
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
    const send = (message: PresenceClientEvent) => socket.send(JSON.stringify(message))
    if (team !== undefined) send({ type: 'presence-update', team })
    return {
      sessionId: event.sessionId,
      events,
      send,
      close: () => socket.close(),
      /** The run as this socket last heard it. */
      run(): CaptureRun | null | undefined {
        const last = events.filter((e) => e.type === 'capture').at(-1)
        return last?.type === 'capture' ? last.run : undefined
      },
      /** The peers this socket was last told it sees. */
      peers(): string[] {
        const seen = new Set<string>()
        for (const e of events)
          if (e.type === 'presence-ready') for (const peer of e.peers) seen.add(peer.sessionId)
          else if (e.type === 'presence-delta') {
            for (const peer of e.upsert) seen.add(peer.sessionId)
            for (const id of e.remove) seen.delete(id)
          }
        return [...seen]
      },
    }
  }
  return {
    base,
    directory,
    stop,
    painterToken,
    admin: (team?: TerritoryTeam) => connect(ADMIN, team),
    painter: (team?: TerritoryTeam) => connect(painterToken, team),
    runner: (team?: TerritoryTeam) => connect(runnerToken, team),
  }
}

const GREEN = 2
const ORANGE = 1

const line = (y: number) => [636_000, y, 636_001, y]

it('runs no capture runs on a server that is not an event server', async () => {
  const server = await start({ eventServer: false })
  const info = await (
    await fetch(`${server.base}/server`, { headers: { authorization: `Bearer ${ADMIN}` } })
  ).json()
  expect(info).not.toHaveProperty('capture')
  const admin = await server.admin(GREEN)
  admin.send({ type: 'capture-open', painters: 1, guards: 0 })
  admin.send({ type: 'clock', sent: 1 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(
    admin.events.filter((event) => event.type === 'capture' || event.type === 'clock'),
  ).toEqual([])
})

it('keeps a run saved as an event server from clients once it is not one', async () => {
  const before = await start()
  const admin = await before.admin(GREEN)
  admin.send({ type: 'capture-open', painters: 1, guards: 0 })
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
  const admin = await server.admin(GREEN)
  const first = await server.painter(GREEN)
  const second = await server.painter(GREEN)

  first.send({ type: 'capture-open', painters: 1, guards: 1 })
  admin.send({ type: 'capture-open', painters: 1, guards: 1 })
  await vi.waitFor(() => expect(first.run()).toMatchObject({ team: GREEN, painters: 1, guards: 1 }))

  // Orange runs its own capture in the same room: it never hears Green's, and joining joins its own.
  const orange = await server.admin(ORANGE)
  orange.send({ type: 'capture-open', painters: 2, guards: 0 })
  await vi.waitFor(() => expect(orange.run()).toMatchObject({ team: ORANGE, painters: 2 }))
  const id = first.run()?.id ?? ''
  // A join names the run it chose, so Green's id joins nothing on Orange's run.
  orange.send({ type: 'capture-join', run: id })
  orange.send({ type: 'capture-join', run: orange.run()?.id ?? '' })
  first.send({ type: 'capture-join', run: id })
  second.send({ type: 'capture-join', run: id })
  // Opening again does not replace a run in progress.
  admin.send({ type: 'capture-open', painters: 3, guards: 0 })
  await vi.waitFor(() => expect(admin.run()?.members).toHaveLength(2))
  await vi.waitFor(() => expect(orange.run()?.members).toHaveLength(1))
  expect(admin.run()).toMatchObject({ id, painters: 1 })
  expect(admin.run()?.members.map((m) => m.sessionId)).not.toContain(orange.sessionId)
  expect(orange.events.some((e) => e.type === 'capture' && e.run?.team === GREEN)).toBe(false)
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
  const late = await server.painter(GREEN)
  await vi.waitFor(() => expect(late.run()?.startsAt).toBe(startsAt))
  late.send({ type: 'capture-join', run: id })
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

it('lets an event runner run a capture that a reporter cannot open', async () => {
  const server = await start()
  const painter = await server.painter(GREEN)
  const runner = await server.runner(GREEN)

  painter.send({ type: 'capture-open', painters: 1, guards: 0 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(painter.run() ?? null).toBeNull()

  runner.send({ type: 'capture-open', painters: 1, guards: 0 })
  await vi.waitFor(() => expect(painter.run()).toMatchObject({ team: GREEN, painters: 1 }))
  painter.send({ type: 'capture-join', run: painter.run()?.id ?? '' })
  await vi.waitFor(() => expect(painter.run()?.members).toHaveLength(1))
  runner.send({ type: 'capture-plan', lines: [line(1_028_000)] })
  await vi.waitFor(() => expect(painter.run()?.lines).toHaveLength(1))
  painter.send({ type: 'capture-close' })
  runner.send({ type: 'capture-go' })
  await vi.waitFor(() => expect(painter.run()?.startsAt).not.toBeNull())
  runner.send({ type: 'capture-close' })
  await vi.waitFor(() => expect(painter.run()).toBeNull())
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

it('shares viewports within a team only, and takes no claims, on an event server', async () => {
  const server = await start()
  const viewport = { x: 636_000, y: 1_028_000, w: 64, h: 64 }
  const green = await server.painter(GREEN)
  const teammate = await server.painter(GREEN)
  const orange = await server.painter(ORANGE)
  for (const session of [green, teammate, orange])
    session.send({ type: 'presence-update', viewport })
  await vi.waitFor(() => expect(green.peers()).toEqual([teammate.sessionId]), { timeout: 5_000 })
  expect(orange.peers()).toEqual([])

  const claim = await fetch(`${server.base}/work/regions/${uuidV7()}?season=0`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: '{}',
  })
  expect(claim.status).toBe(403)
})

it('keeps claims made before the switch to event mode out of it, and does not renew them', async () => {
  const before = await start({ eventServer: false })
  const regions = (server: { base: string; painterToken: string }) =>
    fetch(`${server.base}/work/regions?season=0&painterId=1`, {
      headers: { authorization: `Bearer ${server.painterToken}` },
    }).then((response) => response.json())
  const put = await fetch(`${before.base}/work/regions/${uuidV7()}?season=0`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${before.painterToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      actor: { wplaceUserId: 1, displayName: 'Painter 1' },
      label: 'Old claim',
      document: {
        items: [
          {
            id: 'shape',
            op: 'add',
            shape: { kind: 'rectangle', x: 636_000, y: 1_028_000, w: 4, h: 4 },
          },
        ],
      },
    }),
  })
  expect(put.status).toBe(200)
  const [claimed] = (await regions(before)).regions
  expect(claimed).toBeDefined()
  await before.stop()
  // Renewal stamps the current time, so let it move past the claim's own.
  await new Promise((resolve) => setTimeout(resolve, 20))

  const event = await start({ directory: before.directory })
  expect(await regions(event)).toMatchObject({ regions: [], ownedRegionIds: [] })
  // Painter 1 holds the claim's credential and identity, so connecting would renew it.
  const painter = await event.painter(GREEN)
  expect(painter.events[0]).toMatchObject({
    type: 'presence-ready',
    regions: [],
    ownedRegionIds: [],
  })
  painter.send({ type: 'presence-update', viewport: { x: 636_000, y: 1_028_000, w: 64, h: 64 } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(painter.events.filter((e) => e.type === 'regions' || e.type === 'claims-renewed')).toEqual(
    [],
  )
  painter.close()
  await event.stop()

  const after = await start({ eventServer: false, directory: before.directory })
  expect((await regions(after)).regions).toEqual([claimed])
})
