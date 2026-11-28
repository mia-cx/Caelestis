import { TERRITORY_EVENT } from '@caelestis/shared'
import type { CaptureRunIntent } from '@caelestis/ui/elements'
import { afterEach, expect, it, vi } from 'vitest'
import { connectPresence, FakeWebSocket, SELF_SESSION } from './presence-socket.js'

const painter = { wplaceUserId: 42, displayName: 'Mia' }

vi.mock('../src/wplace-account.js', () => ({
  accountIdentity: () => painter,
  loadAccount: async () => undefined,
}))
// Wplace's leaderboard puts this runner on team 0.
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

/** A page load: stored settings read, then an event runner connected to an event server. */
const load = async () => {
  ;(await import('../src/settings.js')).loadState()
  const connected = await connectPresence({ capture: 1, scope: 'event_runner' })
  dispose = connected.dispose
  vi.setSystemTime(TERRITORY_EVENT.startsAt + 3_600_000)
  const { installCaptureRuns } = await import('../src/capture-runs.js')
  installCaptureRuns()
  return connected.socket
}

const reload = () => {
  dispose?.()
  vi.clearAllTimers()
  vi.resetModules()
  FakeWebSocket.instances = []
  return load()
}

const intent = (detail: CaptureRunIntent) =>
  document
    .getElementById('caelestis-capture-run')
    ?.dispatchEvent(new CustomEvent('caelestis-capture-run-intent', { detail }))

const sent = (socket: FakeWebSocket, type: string) =>
  socket.sent.map((data) => JSON.parse(data)).filter((event) => event.type === type)

/** A runner's own lobby, as a server opened it from their settings. */
const lobby = {
  id: 'run',
  team: 0,
  opener: painter.wplaceUserId,
  coordinator: painter.wplaceUserId,
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

it('opens every new lobby with the settings a runner last chose, after a reload too', async () => {
  let socket = await load()
  socket.receive({ type: 'capture-runs', runs: [lobby] })
  // Two edits before the server answers either: both are kept.
  intent({ type: 'set-lead', leadMs: 4_000 })
  intent({ type: 'set-guards', guards: 2 })
  expect(sent(socket, 'capture-settings')).toEqual([
    { type: 'capture-settings', leadMs: 4_000 },
    { type: 'capture-settings', guards: 2 },
  ])

  socket = await reload()
  socket.receive({ type: 'capture-runs', runs: [] })
  intent({ type: 'open' })
  await vi.advanceTimersByTimeAsync(0)
  // Guards are saved as chosen; the server lets at most half the lobby guard. Settings this runner
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
const cuesAt = async (place: number) => {
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
    // Go is stamped just after this tab's next tick arms the slot, so the opening beep is on time.
    startsAt: now + 200 + 3_000,
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
