import { TERRITORY_EVENT } from '@caelestis/shared'
import type { CaptureRunIntent, CaptureRunModel } from '@caelestis/ui/elements'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectPresence, FakeWebSocket, SELF_SESSION } from './presence-socket.js'

const painter = { wplaceUserId: 42, displayName: 'Mia' }

vi.mock('../src/wplace-account.js', () => ({
  accountIdentity: () => painter,
  loadAccount: async () => undefined,
}))
// Wplace's leaderboard puts this painter on team 0.
vi.mock('../src/event-team.js', () => ({ eventTeam: () => 0, readEventTeam: async () => 0 }))
vi.mock('../src/capture-planning.js', () => ({ planProposals: async () => [] }))
const audio = vi.hoisted(() => ({ cues: [] as { at: number; tone: string }[] }))
vi.mock('../src/capture-cues.js', () => ({
  primeCaptureAudio: () => {},
  scheduleCaptureCues: (cues: { at: number; tone: string }[]) => {
    audio.cues = cues
    return () => {}
  },
}))
// A map looking at the arena, so the capture card shows.
vi.mock('../src/map-handle.js', async (importOriginal) => {
  const { canvasPixelToLatLng, TERRITORY_ARENA, TILE_SIZE } = await import('@caelestis/shared')
  const left = TERRITORY_ARENA.tileX * TILE_SIZE
  const top = TERRITORY_ARENA.tileY * TILE_SIZE
  const map = {
    getCanvas: () => ({ clientWidth: 1_000, clientHeight: 1_000 }),
    unproject: ([x, y]: [number, number]) => canvasPixelToLatLng({ x: left + x, y: top + y }),
    getCenter: () => canvasPixelToLatLng({ x: left + 500, y: top + 500 }),
    triggerRepaint: () => {},
    on: () => {},
    off: () => {},
  }
  return {
    ...(await importOriginal<typeof import('../src/map-handle.js')>()),
    getMap: () => map,
    onMapAttached: () => () => {},
  }
})

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.resetModules()
  FakeWebSocket.instances = []
})

/** A page load: stored settings read, then a painter connected to an event server. */
const load = async (scope: 'report' | 'admin' = 'report') => {
  ;(await import('../src/settings.js')).loadState()
  const connected = await connectPresence({ capture: 1, scope, canWrite: true })
  dispose = connected.dispose
  vi.setSystemTime(TERRITORY_EVENT.startsAt + 3_600_000)
  const { installCaptureRuns } = await import('../src/capture-runs.js')
  installCaptureRuns()
  return connected.socket
}

const reload = (scope?: 'report' | 'admin') => {
  dispose?.()
  vi.clearAllTimers()
  vi.resetModules()
  FakeWebSocket.instances = []
  return load(scope)
}

const intent = (detail: CaptureRunIntent) =>
  document
    .getElementById('caelestis-capture-run')
    ?.dispatchEvent(new CustomEvent('caelestis-capture-run-intent', { detail }))

const sent = (socket: FakeWebSocket, type: string) =>
  socket.sent.map((data) => JSON.parse(data)).filter((event) => event.type === type)

/** This painter's own lobby, as a server opened it from their settings. */
const lobby = {
  id: 'run',
  team: 0,
  opener: painter.wplaceUserId,
  coordinator: painter.wplaceUserId,
  host: SELF_SESSION,
  painters: 5,
  guards: 0,
  distribution: 'even',
  startsAt: null,
  staggerMs: 750,
  cut: 0,
  members: [{ sessionId: SELF_SESSION, painter, drafted: 0 }],
  wall: null,
  guardZones: [],
}

it('opens every new lobby with the settings its host last chose, after a reload too', async () => {
  let socket = await load()
  socket.receive({ type: 'capture-runs', runs: [lobby] })
  // Another tab's whole saved state, as it holds it before this painter changes anything.
  const { storedValue, storeValue } = await import('../src/stored-values.js')
  const { setState } = await import('../src/settings.js')
  setState({ notifyUpdates: false })
  const otherTab = storedValue('caelestis.state.v2') ?? '{}'
  // Two edits before the server answers either: both are kept.
  intent({ type: 'set-lead', leadMs: 4_000 })
  intent({ type: 'set-guards', guards: 2 })
  expect(sent(socket, 'capture-settings')).toEqual([
    { type: 'capture-settings', leadMs: 4_000 },
    { type: 'capture-settings', guards: 2 },
  ])
  // After this tab's last save, the other tab saves an unrelated setting, writing back its copy
  // of the state.
  dispose?.()
  dispose = undefined
  storeValue('caelestis.state.v2', otherTab)

  socket = await reload()
  socket.receive({ type: 'capture-runs', runs: [] })
  intent({ type: 'open' })
  await vi.advanceTimersByTimeAsync(0)
  // Guards are saved as chosen; the server lets at most half the lobby guard. Settings this painter
  // never chose keep their defaults.
  expect(sent(socket, 'capture-new')).toEqual([
    {
      type: 'capture-new',
      painters: 3,
      guards: 2,
      staggerMs: 500,
      leadMs: 4_000,
      distribution: 'even',
    },
  ])
})

/**
 * The beeps this painter hears, in ms from their slot, when a lobby with a three-second lead starts
 * and they paint at member `place`. Six pixels over three painters: places 0 and 1 paint first,
 * place 2 one stagger later.
 */
const cuesAt = async (place: number, lateMs = 0) => {
  const socket = await load()
  const now = Math.round(performance.timeOrigin + performance.now())
  socket.receive({ type: 'clock', sent: now, at: now })
  const others = ['b', 'c'].map((id, index) => ({
    sessionId: id.repeat(16),
    painter: { wplaceUserId: index + 1, displayName: `Painter ${index + 1}` },
    drafted: 0,
  }))
  const me = { sessionId: SELF_SESSION, painter, drafted: 0 }
  const members = [...others.slice(0, place), me, ...others.slice(place)]
  const started = {
    ...lobby,
    coordinator: null,
    members,
    wall: [10, 10, 11, 10, 12, 10, 13, 10, 14, 10, 15, 10],
    // Go is stamped just after this tab's next tick arms the slot, so the opening beep is on time,
    // or, arriving late, 100 ms before this tab hears of it.
    startsAt: (lateMs > 0 ? now - lateMs : now + 200) + 3_000,
    staggerMs: 500,
    leadMs: 3_000,
  }
  socket.receive({ type: 'capture-runs', runs: [started] })
  await vi.advanceTimersByTimeAsync(100)
  const slot = audio.cues.at(-1)?.at ?? 0
  return audio.cues.map(({ at, tone }) => [tone, Math.round(at - slot)])
}

it('counts a three-second countdown down to each slot without doubling a beep', async () => {
  // The first painter's opening beep is their 3.
  expect(await cuesAt(0)).toEqual([
    ['tick', -3_000],
    ['tick', -2_000],
    ['tick', -1_000],
    ['go', 0],
  ])
})

it('leaves out a tick that would land half a second after the opening beep', async () => {
  expect(await cuesAt(2)).toEqual([
    ['tick', -3_500],
    ['tick', -2_000],
    ['tick', -1_000],
    ['go', 0],
  ])
})

it('keeps the opening beep and the two-second tick for a painter whom Go reached a moment late', async () => {
  const cues = await cuesAt(0, 100)
  // The opening beep plays on arrival, still well clear of the two-second tick.
  expect(cues).toHaveLength(4)
  const [opening] = cues
  expect(opening?.[0]).toBe('tick')
  expect(Number(opening?.[1])).toBeLessThan(-2_400)
  expect(cues.slice(-3)).toEqual([
    ['tick', -2_000],
    ['tick', -1_000],
    ['go', 0],
  ])
})

it('leaves out an opening beep that Go brought so late it would sound with the next tick', async () => {
  const cues = await cuesAt(0, 850)
  expect(cues).toEqual([
    ['tick', -2_000],
    ['tick', -1_000],
    ['go', 0],
  ])
})

it('saves only the setting the host changed, under its own key', async () => {
  const socket = await load()
  socket.receive({ type: 'capture-runs', runs: [lobby] })
  const stored = await import('../src/stored-values.js')
  const writes = vi.spyOn(stored, 'storeValue')
  intent({ type: 'set-guards', guards: 2 })
  // Another tab's newer Countdown, under its own key, can't be written back from this tab's copy.
  expect(writes.mock.calls.filter(([key]) => key.startsWith('caelestis.capture-lobby'))).toEqual([
    ['caelestis.capture-lobby.guards', '2'],
  ])
})

describe('hosting', () => {
  const model = () =>
    (
      document.getElementById('caelestis-capture-run') as
        | (HTMLElement & { model?: CaptureRunModel })
        | null
    )?.model
  const bea = { wplaceUserId: 7, displayName: 'Bea' }
  const member = (id: string, who = bea, joined = 0) => ({
    sessionId: id.repeat(16),
    painter: who,
    drafted: 0,
    joined,
  })
  /** Bea's lobby, which this painter joined after her. */
  const beas = {
    ...lobby,
    opener: bea.wplaceUserId,
    coordinator: bea.wplaceUserId,
    host: 'b'.repeat(16),
    members: [member('b'), { sessionId: SELF_SESSION, painter, drafted: 0, joined: 1 }],
  }
  const receive = async (socket: FakeWebSocket, runs: readonly object[]) => {
    socket.receive({ type: 'capture-runs', runs })
    await vi.advanceTimersByTimeAsync(0)
  }

  it('lists the largest lobby first, lobbies of one size oldest first, and offers New lobby', async () => {
    const socket = await load()
    const cy = { wplaceUserId: 8, displayName: 'Cy' }
    const of = (id: string, host: typeof bea, size: number) => ({
      ...lobby,
      id,
      opener: host.wplaceUserId,
      coordinator: host.wplaceUserId,
      host: 'b'.repeat(16),
      members: Array.from({ length: size }, (_, index) =>
        member(index === 0 ? 'b' : String(index), index === 0 ? host : cy, index),
      ),
    })
    // Lobby ids are UUIDv7, so they order by when each lobby opened, whatever order they arrive in.
    const older = '018f0000-0000-7000-8000-000000000001'
    const newer = '018f0000-0000-7000-8000-000000000002'
    const biggest = '018f0000-0000-7000-8000-000000000003'
    await receive(socket, [of(newer, cy, 1), of(biggest, cy, 3), of(older, bea, 1)])
    expect(model()).toMatchObject({ phase: 'list', canOpen: true })
    expect(model()?.lobbies.map(({ id, name, members }) => [id, name, members])).toEqual([
      [biggest, 'Cy', 3],
      [older, 'Bea', 1],
      [newer, 'Cy', 1],
    ])
  })

  it('gives the running controls to the host alone, or an administrator', async () => {
    let socket = await load()
    await receive(socket, [beas])
    expect(model()).toMatchObject({ phase: 'gathering', canRun: false })
    expect(model()?.members.map(({ name, hosts }) => [name, hosts])).toEqual([
      ['Bea', true],
      ['Mia', false],
    ])
    // Bea leaves: this painter has been in the lobby longest, so hosts it.
    await receive(socket, [{ ...beas, host: SELF_SESSION, members: beas.members.slice(1) }])
    expect(model()).toMatchObject({ canRun: true })
    expect(model()?.members[0]?.hosts).toBe(true)

    // An administrator runs a lobby they don't host.
    socket = await reload('admin')
    await receive(socket, [beas])
    expect(model()).toMatchObject({ canRun: true })
  })
})
