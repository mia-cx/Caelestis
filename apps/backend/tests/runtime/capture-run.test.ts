import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPTURE_LEAD_MS,
  type CaptureRun,
  captureSlot,
  millis,
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
import { hashToken } from '../../src/auth/tokens.js'
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
  const mint = async (scope: 'report') => {
    const minted = await fetch(`${base}/admin/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: scope, scope }),
    })
    return ((await minted.json()) as { token: string }).token
  }
  const painterToken = await mint('report')
  // Nothing mints event-runner invites now; one minted by backend 1.6.0 still exchanges.
  const invite = 'capture-runner-invite'
  await runtime.sql.insertAccessToken({
    tokenHash: await hashToken(invite),
    label: 'Runner',
    scope: 'event_runner',
    createdWithToken: await hashToken(ADMIN),
    createdAt: millis(Date.now()),
    invite: true,
  })
  const exchanged = await fetch(`${base}/auth/exchange`, {
    method: 'POST',
    headers: { authorization: `Bearer ${invite}` },
  })
  const { token: runnerToken } = (await exchanged.json()) as { token: string }

  let nextPainter = 1
  /**
   * A session, which reports `team` as its event team first when given one: a new painter in a new
   * browser, unless `as` names the painter and browser.
   */
  const connect = async (
    token: string,
    team?: TerritoryTeam,
    as = { painterId: nextPainter++, clientId: uuidV7() },
  ) => {
    const { painterId, clientId } = as
    const query = new URLSearchParams({
      season: '0',
      painterId: String(painterId),
      painterName: `Painter ${painterId}`,
      clientId,
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
      painterId,
      clientId,
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
      /** The team this socket last heard `sessionId` report, as its peer. */
      teamOf(sessionId: string): TerritoryTeam | undefined {
        const heard = events.flatMap((e) =>
          e.type === 'presence-ready' ? e.peers : e.type === 'presence-delta' ? e.upsert : [],
        )
        return heard.findLast((peer) => peer.sessionId === sessionId)?.team
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
    /** The same painter on another socket: from the same browser, or from `clientId`'s. */
    again: (
      session: { painterId: number; clientId: string },
      team?: TerritoryTeam,
      clientId = session.clientId,
    ) => connect(painterToken, team, { painterId: session.painterId, clientId }),
    /** A session holding an event-runner token kept from backend 1.6.0. */
    legacyRunner: (team?: TerritoryTeam) => connect(runnerToken, team),
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
  const first = await server.painter(GREEN)
  const second = await server.admin(GREEN)
  const painter = await server.painter(GREEN)
  const orange = await server.admin(ORANGE)

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
  const host = await server.painter(GREEN)
  const painters = [await server.painter(GREEN), await server.painter(GREEN)]
  const late = await server.painter(GREEN)

  host.send({ type: 'capture-new', ...SETTINGS, painters: 1 })
  await vi.waitFor(() => expect(host.run()).toBeDefined())
  const id = host.run()?.id ?? ''
  for (const painter of painters) painter.send({ type: 'capture-join', run: id })
  // More members than the Painters setting is fine; the opener moves to the closing place.
  await vi.waitFor(() =>
    expect(host.run()?.members.map((m) => m.sessionId)).toEqual([
      painters[0]?.sessionId,
      painters[1]?.sessionId,
      host.sessionId,
    ]),
  )

  // A 180-pixel wall is three full legs; with three members it locks in.
  host.send({ type: 'capture-lock', wall: wall(181), guardZones: [] })
  await settle()
  expect(host.run()?.wall).toBeNull()
  host.send({ type: 'capture-lock', wall: wall(180), guardZones: [] })
  await vi.waitFor(() => expect(painters[0]?.run()?.wall).toHaveLength(360))

  const cut = host.run()?.cut ?? 0
  const lobby = host.run()?.id ?? ''
  for (const session of [painters[0], host])
    session?.send({ type: 'capture-drafted', run: lobby, drafted: 60, cut })
  await vi.waitFor(() => expect(host.run()?.members.map((m) => m.drafted)).toEqual([60, 0, 60]))
  host.send({ type: 'capture-go' })
  await settle()
  expect(host.run()?.startsAt).toBeNull()

  painters[1]?.send({ type: 'capture-drafted', run: lobby, drafted: 60, cut })
  await vi.waitFor(() => expect(host.run()?.members[1]?.drafted).toBe(60))
  const before = Date.now()
  host.send({ type: 'capture-go' })
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
  expect(host.run()?.members).toHaveLength(3)

  host.send({ type: 'capture-close' })
  await vi.waitFor(() => expect(painters[1]?.runs()).toEqual([]))
})

it('lets the host give the closing leg to another member', async () => {
  const server = await start()
  const host = await server.painter(GREEN)
  const painter = await server.painter(GREEN)
  host.send({ type: 'capture-new', ...SETTINGS })
  await vi.waitFor(() => expect(host.run()).toBeDefined())
  painter.send({ type: 'capture-join', run: host.run()?.id ?? '' })
  await vi.waitFor(() => expect(host.run()?.members).toHaveLength(2))
  const closer = () => host.run()?.members.at(-1)?.sessionId

  // A painter can't take it.
  painter.send({ type: 'capture-closer', member: painter.sessionId })
  await settle()
  expect(closer()).toBe(host.sessionId)
  host.send({ type: 'capture-closer', member: painter.sessionId })
  await vi.waitFor(() => expect(closer()).toBe(painter.sessionId))
})

it('lets a painter host a lobby, passing it on when they disconnect', async () => {
  const server = await start()
  const host = await server.painter(GREEN)
  const second = await server.painter(GREEN)
  const third = await server.painter(GREEN)
  host.send({ type: 'capture-new', ...SETTINGS })
  await vi.waitFor(() => expect(host.run()).toBeDefined())
  const id = host.run()?.id ?? ''
  second.send({ type: 'capture-join', run: id })
  await vi.waitFor(() => expect(host.run()?.members).toHaveLength(2))
  third.send({ type: 'capture-join', run: id })
  await vi.waitFor(() => expect(host.run()?.members).toHaveLength(3))
  expect(host.run()?.host).toBe(host.sessionId)

  // Another member can't run it; the host can.
  second.send({ type: 'capture-settings', painters: 6 })
  await settle()
  expect(host.run()?.painters).toBe(3)
  host.send({ type: 'capture-settings', painters: 5 })
  await vi.waitFor(() => expect(second.run()?.painters).toBe(5))

  // The host's tab closes: the member who joined next hosts, and runs it.
  host.close()
  await vi.waitFor(() => expect(third.run()?.host).toBe(second.sessionId))
  third.send({ type: 'capture-settings', painters: 7 })
  second.send({ type: 'capture-settings', painters: 4 })
  await vi.waitFor(() => expect(third.run()?.painters).toBe(4))
})

it('lets a kept event-runner token open and host a lobby like any painter', async () => {
  const server = await start()
  const runner = await server.legacyRunner(GREEN)
  const painter = await server.painter(GREEN)
  painter.send({ type: 'capture-new', ...SETTINGS })
  await vi.waitFor(() => expect(runner.runs()).toHaveLength(1))
  runner.send({ type: 'capture-join', run: runner.runs()[0]?.id ?? '' })
  await vi.waitFor(() => expect(painter.run()?.members).toHaveLength(2))
  // In a painter's lobby the runner is only a member.
  runner.send({ type: 'capture-settings', painters: 6 })
  await settle()
  expect(painter.run()?.painters).toBe(3)
  // Its own lobby it hosts.
  runner.send({ type: 'capture-new', ...SETTINGS })
  await vi.waitFor(() => expect(runner.run()?.host).toBe(runner.sessionId))
  runner.send({ type: 'capture-settings', painters: 6 })
  await vi.waitFor(() => expect(runner.run()?.painters).toBe(6))
})

it('leaves a member who switched team during the countdown out of the next round', async () => {
  const server = await start()
  const host = await server.painter(GREEN)
  const painter = await server.painter(GREEN)
  host.send({ type: 'capture-new', painters: 2, staggerMs: 100 })
  await vi.waitFor(() => expect(host.run()).toBeDefined())
  painter.send({ type: 'capture-join', run: host.run()?.id ?? '' })
  await vi.waitFor(() => expect(host.run()?.members).toHaveLength(2))
  host.send({ type: 'capture-lock', wall: wall(60), guardZones: [] })
  await vi.waitFor(() => expect(host.run()?.wall).toHaveLength(120))
  const { id = '', cut = 0 } = host.run() ?? {}
  for (const session of [host, painter])
    session.send({ type: 'capture-drafted', run: id, drafted: 30, cut })
  await vi.waitFor(() => expect(host.run()?.members.map((m) => m.drafted)).toEqual([30, 30]))
  host.send({ type: 'capture-go' })
  await vi.waitFor(() => expect(host.run()?.startsAt).not.toBeNull())
  // Mid-countdown the painter reports another team; their socket stays open.
  painter.send({ type: 'presence-update', team: ORANGE })
  await settle()
  // Once the capture has finished, the host plans the next shape.
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.now() + 60_000)
    host.send({ type: 'capture-unlock' })
    await settle()
  } finally {
    vi.useRealTimers()
  }
  expect(host.run()).toMatchObject({ startsAt: null, wall: null })
  expect(host.run()?.members.map((m) => m.sessionId)).toEqual([host.sessionId])
}, 20_000)

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

it('shows an admin every team, and each peer its team, on an event server', async () => {
  const server = await start()
  const viewport = { x: 636_000, y: 1_028_000, w: 64, h: 64 }
  const green = await server.painter(GREEN)
  const orange = await server.legacyRunner(ORANGE)
  const admin = await server.admin(GREEN)
  for (const session of [green, orange, admin]) session.send({ type: 'presence-update', viewport })

  await vi.waitFor(
    () => expect(admin.peers().sort()).toEqual([green.sessionId, orange.sessionId].sort()),
    { timeout: 5_000 },
  )
  expect(admin.teamOf(green.sessionId)).toBe(GREEN)
  expect(admin.teamOf(orange.sessionId)).toBe(ORANGE)
  // The admin is an ordinary member of its own team to everyone else.
  await vi.waitFor(() => expect(green.peers()).toEqual([admin.sessionId]), { timeout: 5_000 })
  expect(green.teamOf(admin.sessionId)).toBe(GREEN)
  expect(orange.peers()).toEqual([])
})

it('sends peers without a team on a server that is not an event server', async () => {
  const server = await start({ eventServer: false })
  const viewport = { x: 636_000, y: 1_028_000, w: 64, h: 64 }
  const painter = await server.painter(GREEN)
  const admin = await server.admin(ORANGE)
  for (const session of [painter, admin]) session.send({ type: 'presence-update', viewport })
  await vi.waitFor(() => expect(admin.peers()).toEqual([painter.sessionId]), { timeout: 5_000 })
  expect(admin.teamOf(painter.sessionId)).toBeUndefined()
})

it.each(['painter', 'legacyRunner'] as const)(
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

it('logs a countdown as it starts, and each slot report from a member of it', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const lines = (event: string) =>
    info.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as { event?: unknown }
        } catch {
          return null
        }
      })
      .filter((line) => line?.event === event)
  const server = await start()
  const host = await server.painter(GREEN)
  host.send({ type: 'capture-new', ...SETTINGS, painters: 1 })
  await vi.waitFor(() => expect(host.run()).toBeDefined())
  host.send({ type: 'capture-lock', wall: wall(60), guardZones: [] })
  await vi.waitFor(() => expect(host.run()?.wall).toHaveLength(120))
  const lobby = host.run()
  host.send({ type: 'capture-drafted', run: lobby?.id ?? '', drafted: 60, cut: lobby?.cut ?? 0 })
  await vi.waitFor(() => expect(host.run()?.members[0]?.drafted).toBe(60))
  host.send({ type: 'capture-go' })
  await vi.waitFor(() => expect(host.run()?.startsAt).not.toBeNull())
  const run = host.run()
  if (run === undefined || run.startsAt === null) throw new Error('Expected a started lobby')
  await vi.waitFor(() =>
    expect(lines('capture-countdown')).toEqual([
      {
        event: 'capture-countdown',
        lobby: run.id,
        team: GREEN,
        startsAt: run.startsAt,
        staggerMs: SETTINGS.staggerMs,
        members: [{ name: 'Painter 1', userId: 1, role: 'painter', step: 0 }],
      },
    ]),
  )

  const report = {
    type: 'capture-timing',
    run: run.id,
    slotAt: run.startsAt,
    firedLateMs: 2,
    clickToSendMs: 41,
    sendToResponseMs: 180,
    status: 200,
    wplaceRttMs: 95,
    clockOffsetMs: -12,
    clockRttMs: 30,
  } as const
  // Malformed, then for a slot that is not this member's: neither is logged, nor closes the socket.
  host.send({ ...report, firedLateMs: -1 })
  host.send({ ...report, slotAt: run.startsAt + SETTINGS.staggerMs })
  host.send(report)
  await vi.waitFor(() => expect(lines('capture-slot')).toHaveLength(1))
  expect(lines('capture-slot')[0]).toEqual({
    event: 'capture-slot',
    lobby: run.id,
    team: GREEN,
    name: 'Painter 1',
    userId: 1,
    step: 0,
    slotAt: run.startsAt,
    firedLateMs: 2,
    clickToSendMs: 41,
    sendToResponseMs: 180,
    status: 200,
    wplaceRttMs: 95,
    clockOffsetMs: -12,
    clockRttMs: 30,
  })

  // A host closes the lobby while a report is still on its way; it is logged, marked closed.
  // First wait out the presence rate limit's one-second window.
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  host.send({ type: 'capture-close' })
  await vi.waitFor(() => expect(host.runs()).toEqual([]))
  // Reports for a slot it was never given, in that lobby or one that never existed, are not.
  host.send({ ...report, slotAt: run.startsAt + SETTINGS.staggerMs })
  host.send({ ...report, run: uuidV7() })
  host.send({ ...report, status: 'missed', clickToSendMs: null, sendToResponseMs: null })
  await vi.waitFor(() => expect(lines('capture-slot')).toHaveLength(2))
  expect(lines('capture-slot')[1]).toMatchObject({
    lobby: run.id,
    step: 0,
    closed: true,
    status: 'missed',
  })
})

it('logs a slot report from a finished round, through a team switch, until it expires', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const slotLines = () =>
    info.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { event?: string; slotAt?: number })
      .filter((line) => line.event === 'capture-slot')
  const server = await start()
  const host = await server.painter(GREEN)
  const painter = await server.painter(GREEN)
  /** Lock a 60-pixel wall, both members draft their 30-pixel legs, and the countdown starts. */
  const round = async () => {
    host.send({ type: 'capture-lock', wall: wall(60), guardZones: [] })
    await vi.waitFor(() => expect(host.run()?.wall).toHaveLength(120))
    const { id = '', cut = 0 } = host.run() ?? {}
    for (const session of [host, painter])
      session.send({ type: 'capture-drafted', run: id, drafted: 30, cut })
    await vi.waitFor(() => expect(host.run()?.members.map((m) => m.drafted)).toEqual([30, 30]))
    host.send({ type: 'capture-go' })
    await vi.waitFor(() => expect(painter.run()?.startsAt).not.toBeNull())
    return painter.run()?.startsAt ?? 0
  }
  const lobby = () => host.run()?.id ?? ''
  const report = (run: string, slotAt: number) =>
    painter.send({
      type: 'capture-timing',
      run,
      slotAt,
      firedLateMs: 1,
      clickToSendMs: null,
      sendToResponseMs: null,
      status: 'no-response',
      wplaceRttMs: null,
      clockOffsetMs: 0,
      clockRttMs: 10,
    })
  const pause = () => new Promise((resolve) => setTimeout(resolve, 1_100))

  host.send({ type: 'capture-new', ...SETTINGS, painters: 2 })
  await vi.waitFor(() => expect(host.run()).toBeDefined())
  painter.send({ type: 'capture-join', run: lobby() })
  await vi.waitFor(() => expect(host.run()?.members).toHaveLength(2))
  const first = await round()
  const id = lobby()
  await pause()
  // The first round finishes and the next one starts before the painter's report arrives.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(first + 60_000)
  host.send({ type: 'capture-unlock' })
  await settle()
  vi.useRealTimers()
  await vi.waitFor(() => expect(host.run()?.startsAt).toBeNull())
  const second = await round()
  await pause()
  report(id, first)
  await vi.waitFor(() => expect(slotLines().map(({ slotAt }) => slotAt)).toEqual([first]))
  // Reporting another team now, the painter's report still finds its lobby open on Green.
  painter.send({ type: 'presence-update', team: ORANGE })
  report(id, second)
  await vi.waitFor(() => expect(slotLines()).toHaveLength(2))
  expect(slotLines()[1]).not.toHaveProperty('closed')
  await pause()
  // Two minutes past the closing slot, a report is no longer logged.
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(second + 180_000)
    report(id, second)
    await settle()
  } finally {
    vi.useRealTimers()
  }
  expect(slotLines()).toHaveLength(2)
}, 30_000)

it('hands a place to the same browser rejoining, and logs slot reports from both of its tabs', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const slots = () =>
    info.mock.calls.filter(([line]) => String(line).includes('"event":"capture-slot"'))
  const server = await start()
  const host = await server.painter(GREEN)
  host.send({ type: 'capture-new', ...SETTINGS, painters: 1 })
  await vi.waitFor(() => expect(host.run()).toBeDefined())
  host.send({ type: 'capture-lock', wall: wall(60), guardZones: [] })
  await vi.waitFor(() => expect(host.run()?.wall).toHaveLength(120))
  const lobby = host.run()
  host.send({ type: 'capture-drafted', run: lobby?.id ?? '', drafted: 60, cut: lobby?.cut ?? 0 })
  await vi.waitFor(() => expect(host.run()?.members[0]?.drafted).toBe(60))
  host.send({ type: 'capture-go' })
  await vi.waitFor(() => expect(host.run()?.startsAt).not.toBeNull())
  const run = host.run()
  if (run === undefined || run.startsAt === null) throw new Error('Expected a started lobby')

  // Someone claiming the same painter from another browser gets nothing.
  const impostor = await server.again(host, GREEN, uuidV7())
  impostor.send({ type: 'capture-join', run: run.id })
  await settle()
  expect(impostor.run()).toBeUndefined()
  // The same browser in a new tab takes the place, slot and all; nobody is told whose browser.
  const tab = await server.again(host, GREEN)
  tab.send({ type: 'capture-join', run: run.id })
  await vi.waitFor(() =>
    expect(tab.run()?.members.map(({ sessionId }) => sessionId)).toEqual([tab.sessionId]),
  )
  expect(tab.run()?.members.some((member) => 'client' in member)).toBe(false)

  const report = {
    type: 'capture-timing',
    run: run.id,
    slotAt: run.startsAt,
    firedLateMs: 2,
    clickToSendMs: 41,
    sendToResponseMs: 180,
    status: 200,
    wplaceRttMs: 95,
    clockOffsetMs: -12,
    clockRttMs: 30,
  } as const
  // The old tab's paint was already on its way; the new tab paints too.
  host.send(report)
  tab.send(report)
  await vi.waitFor(() => expect(slots()).toHaveLength(2))
})
