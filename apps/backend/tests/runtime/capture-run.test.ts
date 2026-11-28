import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPTURE_LEAD_MS,
  type CaptureRun,
  captureSlot,
  PRESENCE_PROTOCOL_V1,
  type PresenceClientEvent,
  type PresenceServerEvent,
  type RegionClaim,
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
      /** The team's lobbies as this socket last heard them. */
      runs(): readonly CaptureRun[] {
        const last = events.filter((e) => e.type === 'capture-runs').at(-1)
        return last?.type === 'capture-runs' ? last.runs : []
      },
      /** The lobby this socket is a member of, as it last heard it. */
      run(): CaptureRun | undefined {
        return this.runs().find((run) => run.members.some((m) => m.sessionId === event.sessionId))
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

const SETTINGS = { painters: 3, staggerMs: 500 }
/** A straight wall of `pixels` in the arena, from anchor A to anchor B. */
const wall = (pixels: number) =>
  Array.from({ length: pixels }, (_, x) => [636_000 + x, 1_028_000]).flat()
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

it('runs no capture lobbies on a server that is not an event server', async () => {
  const server = await start({ eventServer: false })
  const info = await (
    await fetch(`${server.base}/server`, { headers: { authorization: `Bearer ${ADMIN}` } })
  ).json()
  expect(info).not.toHaveProperty('capture')
  const admin = await server.admin(GREEN)
  admin.send({ type: 'capture-new', ...SETTINGS })
  admin.send({ type: 'clock', sent: 1 })
  await settle()
  expect(
    admin.events.filter((event) => event.type === 'capture-runs' || event.type === 'clock'),
  ).toEqual([])
})

it('keeps lobbies saved as an event server from clients once it is not one', async () => {
  const before = await start()
  const admin = await before.admin(GREEN)
  admin.send({ type: 'capture-new', ...SETTINGS })
  await vi.waitFor(() => expect(admin.run()).toBeDefined())
  await before.stop()

  const after = await start({ eventServer: false, directory: before.directory })
  const painter = await after.painter()
  await settle()
  expect(painter.events.filter((event) => event.type === 'capture-runs')).toEqual([])
})

it('ignores the single-run events of userscripts from before lobbies', async () => {
  const server = await start()
  const admin = await server.admin(GREEN)
  const painter = await server.painter(GREEN)
  const send = (message: object) => admin.send(message as PresenceClientEvent)
  send({ type: 'capture-open', painters: 1, guards: 0, staggerMs: 500 })
  send({ type: 'capture-plan', lines: [[636_000, 1_028_000]] })
  await settle()
  expect(painter.runs()).toEqual([])
  // The socket survives the old events, and a lobby opened after them still reaches everyone.
  admin.send({ type: 'capture-new', ...SETTINGS })
  await vi.waitFor(() => expect(painter.runs()).toHaveLength(1))
})

it('lists several lobbies per team, each kept from the other teams', async () => {
  const server = await start()
  const first = await server.runner(GREEN)
  const second = await server.admin(GREEN)
  const painter = await server.painter(GREEN)
  const orange = await server.admin(ORANGE)

  // A reporter can't open one.
  painter.send({ type: 'capture-new', ...SETTINGS })
  first.send({ type: 'capture-new', ...SETTINGS })
  second.send({ type: 'capture-new', ...SETTINGS, painters: 5 })
  orange.send({ type: 'capture-new', ...SETTINGS })
  await vi.waitFor(() => expect(painter.runs()).toHaveLength(2))
  await vi.waitFor(() => expect(orange.runs()).toHaveLength(1))
  expect(painter.runs().map((run) => [run.team, run.painters])).toEqual([
    [GREEN, 3],
    [GREEN, 5],
  ])
  // Green's id joins nothing for Orange.
  const [green] = painter.runs()
  orange.send({ type: 'capture-join', run: green?.id ?? '' })
  await settle()
  expect(painter.runs()[0]?.members).toHaveLength(1)
  expect(
    orange.events.some((e) => e.type === 'capture-runs' && e.runs.some((r) => r.team === GREEN)),
  ).toBe(false)

  // The last member leaving closes the lobby.
  second.send({ type: 'capture-leave' })
  await vi.waitFor(() => expect(painter.runs()).toHaveLength(1))
})

it('runs a lobby from opening to the countdown, cutting the wall for whoever is in it', async () => {
  const server = await start()
  const runner = await server.runner(GREEN)
  const painters = [await server.painter(GREEN), await server.painter(GREEN)]
  const late = await server.painter(GREEN)

  runner.send({ type: 'capture-new', ...SETTINGS, painters: 1 })
  await vi.waitFor(() => expect(runner.run()).toBeDefined())
  const id = runner.run()?.id ?? ''
  for (const painter of painters) painter.send({ type: 'capture-join', run: id })
  // More members than the Painters setting is fine; the opener moves to the closing place.
  await vi.waitFor(() =>
    expect(runner.run()?.members.map((m) => m.sessionId)).toEqual([
      painters[0]?.sessionId,
      painters[1]?.sessionId,
      runner.sessionId,
    ]),
  )

  // A 180-pixel wall is three full legs; with three members it locks in.
  runner.send({ type: 'capture-lock', wall: wall(181), guardZones: [] })
  await settle()
  expect(runner.run()?.wall).toBeNull()
  runner.send({ type: 'capture-lock', wall: wall(180), guardZones: [] })
  await vi.waitFor(() => expect(painters[0]?.run()?.wall).toHaveLength(360))

  const cut = runner.run()?.cut ?? 0
  const lobby = runner.run()?.id ?? ''
  for (const session of [painters[0], runner])
    session?.send({ type: 'capture-drafted', run: lobby, drafted: 60, cut })
  await vi.waitFor(() => expect(runner.run()?.members.map((m) => m.drafted)).toEqual([60, 0, 60]))
  runner.send({ type: 'capture-go' })
  await settle()
  expect(runner.run()?.startsAt).toBeNull()

  painters[1]?.send({ type: 'capture-drafted', run: lobby, drafted: 60, cut })
  await vi.waitFor(() => expect(runner.run()?.members[1]?.drafted).toBe(60))
  const before = Date.now()
  runner.send({ type: 'capture-go' })
  await vi.waitFor(() => expect(late.runs()[0]?.startsAt).not.toBeNull())
  const run = late.runs()[0]
  if (run === undefined || run.startsAt === null) throw new Error('Expected a started lobby')
  expect(run.startsAt - before).toBeGreaterThanOrEqual(CAPTURE_LEAD_MS - 1_000)
  // The pair goes first, the opener a stagger later on the closing leg.
  expect(captureSlot(run, 2)).toBe(run.startsAt + 500)

  // A late joiner can't join, and a member who drops keeps their slot.
  late.send({ type: 'capture-join', run: id })
  painters[0]?.close()
  await settle()
  expect(runner.run()?.members).toHaveLength(3)

  runner.send({ type: 'capture-close' })
  await vi.waitFor(() => expect(painters[1]?.runs()).toEqual([]))
})

it('lets a runner give the closing leg to another member', async () => {
  const server = await start()
  const runner = await server.runner(GREEN)
  const painter = await server.painter(GREEN)
  runner.send({ type: 'capture-new', ...SETTINGS })
  await vi.waitFor(() => expect(runner.run()).toBeDefined())
  painter.send({ type: 'capture-join', run: runner.run()?.id ?? '' })
  await vi.waitFor(() => expect(runner.run()?.members).toHaveLength(2))
  const closer = () => runner.run()?.members.at(-1)?.sessionId

  // A painter can't take it.
  painter.send({ type: 'capture-closer', member: painter.sessionId })
  await settle()
  expect(closer()).toBe(runner.sessionId)
  runner.send({ type: 'capture-closer', member: painter.sessionId })
  await vi.waitFor(() => expect(closer()).toBe(painter.sessionId))
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

it.each(['painter', 'runner'] as const)(
  'lets one %s token connect as two teams, each seeing only its own team',
  async (kind) => {
    const server = await start()
    const viewport = { x: 636_000, y: 1_028_000, w: 64, h: 64 }
    // Both sessions hold the same token; only the team each reports differs.
    const green = await server[kind](GREEN)
    const orange = await server[kind](ORANGE)
    const greenAdmin = await server.admin(GREEN)
    const orangeAdmin = await server.admin(ORANGE)
    for (const session of [green, orange, greenAdmin, orangeAdmin])
      session.send({ type: 'presence-update', viewport })
    greenAdmin.send({ type: 'capture-new', ...SETTINGS, painters: 1 })
    orangeAdmin.send({ type: 'capture-new', ...SETTINGS, painters: 2 })

    await vi.waitFor(() => expect(green.peers()).toEqual([greenAdmin.sessionId]), {
      timeout: 5_000,
    })
    await vi.waitFor(() => expect(orange.peers()).toEqual([orangeAdmin.sessionId]), {
      timeout: 5_000,
    })
    await vi.waitFor(() => expect(green.runs()).toMatchObject([{ team: GREEN, painters: 1 }]))
    await vi.waitFor(() => expect(orange.runs()).toMatchObject([{ team: ORANGE, painters: 2 }]))
    const heard = (session: typeof green, team: TerritoryTeam) =>
      session.events.some((e) => e.type === 'capture-runs' && e.runs.some((r) => r.team === team))
    expect(heard(green, ORANGE)).toBe(false)
    expect(heard(orange, GREEN)).toBe(false)
  },
)

it('keeps claims made before the switch to event mode out of it, and does not renew them', async () => {
  const before = await start({ eventServer: false })
  const regions = (server: { base: string; painterToken: string }) =>
    fetch(`${server.base}/work/regions?season=0&painterId=1`, {
      headers: { authorization: `Bearer ${server.painterToken}` },
    }).then((response) => response.json() as Promise<{ regions: RegionClaim[] }>)
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
