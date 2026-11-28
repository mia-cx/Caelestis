import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { type PresenceRect, TERRITORY_EVENT } from '@caelestis/shared'
import type { CaptureRunIntent, CaptureRunModel } from '@caelestis/ui/elements'
import { afterEach, expect, it, vi } from 'vitest'
import type { PlannedProposal } from '../src/capture-planning.js'
import { connectPresence, FakeWebSocket, SELF_SESSION } from './presence-socket.js'

const painter = { wplaceUserId: 42, displayName: 'Mia' }
const other = { wplaceUserId: 7, displayName: 'Other painter' }

const planner = vi.hoisted(() => ({ plans: [] as PlannedProposal[] }))

setFlagsFromString('--expose-gc')
const collect: () => void = runInNewContext('gc')

vi.mock('../src/wplace-account.js', () => ({
  accountIdentity: () => painter,
  loadAccount: async () => undefined,
}))
// The planner reads Wplace's territory snapshot; these tests give it the plans it finds instead.
vi.mock('../src/capture-planning.js', () => ({ planProposals: async () => planner.plans }))
// A map looking at the arena's top-left corner, so the capture card shows and plans focus there.
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
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  FakeWebSocket.instances = []
})

const connect = async (options: Parameters<typeof connectPresence>[0] = {}) => {
  const connected = await connectPresence(options)
  dispose = connected.dispose
  return connected
}

const rect = (x: number): PresenceRect => ({ x, y: 10, w: 4, h: 3 })

it('redraws peers from every presence message and reuses the scene between them', async () => {
  const { socket } = await connect()
  const { presenceScene } = await import('../src/presence-scene.js')
  const move = (x: number) =>
    socket.receive({
      type: 'presence-delta',
      online: 2,
      upsert: [{ sessionId: 'b'.repeat(16), painter: other, viewport: rect(x), draft: null }],
      remove: [],
    })
  move(0)
  const first = presenceScene()
  expect(first.map((item) => item.rect)).toEqual([rect(0)])
  // Frames between messages get the same scene, so its masks and items are not rebuilt.
  expect(presenceScene()).toBe(first)
  move(20)
  expect(presenceScene().map((item) => item.rect)).toEqual([rect(20)])
})

const TEAMMATE = 'c'.repeat(16)

/** This painter's team's one lobby, with this painter and a teammate in it. */
const lobby = (
  wall: readonly number[] | null,
  drafted: number,
  joined: readonly string[] = [],
) => ({
  id: 'run',
  team: 0,
  opener: 0,
  coordinator: null,
  host: SELF_SESSION,
  painters: 2,
  guards: 0,
  distribution: 'even',
  startsAt: null,
  staggerMs: 500,
  cut: 0,
  members: [SELF_SESSION, TEAMMATE, ...joined].map((sessionId, index) => ({
    sessionId,
    painter: index === 0 ? painter : other,
    drafted: index === 1 ? drafted : 0,
  })),
  wall,
  guardZones: [],
})

it('cuts the locked wall into legs from every lobby update and reuses them between updates', async () => {
  const { socket } = await connect({ capture: 1 })
  const { captureItems } = await import('../src/capture-runs.js')
  // Four pixels: this painter takes the two from anchor A, the teammate the two from anchor B.
  const wall = [10, 10, 11, 10, 12, 10, 13, 10]
  const update = (drafted: number) =>
    socket.receive({ type: 'capture-runs', runs: [lobby(wall, drafted)] })
  update(0)
  const gathering = captureItems()
  // The teammate's leg is outlined until drafted; this painter's own is still to draft.
  expect(gathering.map((item) => [item.kind, item.rect])).toEqual([
    ['pending', { x: 12, y: 10, w: 2, h: 1 }],
    ['todo', { x: 10, y: 10, w: 2, h: 1 }],
  ])
  expect(captureItems()).toBe(gathering)
  update(2)
  expect(captureItems().map((item) => item.kind)).toEqual(['ready', 'todo'])
})

it('shows a guard zone its guard has drafted as drafted, on the map and in the card', async () => {
  const { socket } = await connect({ capture: 1 })
  vi.setSystemTime(TERRITORY_EVENT.startsAt + 3_600_000)
  const { captureItems, installCaptureRuns } = await import('../src/capture-runs.js')
  installCaptureRuns()
  // Two painters and a guard, who reports both pixels of their zone drafted.
  const wall = [10, 10, 11, 10, 12, 10, 13, 10]
  const zone = { x: 20, y: 20, w: 2, h: 1 }
  const three = lobby(wall, 0, ['e'.repeat(16)])
  const members = three.members.map((member, index) =>
    index === 2 ? { ...member, drafted: 2 } : member,
  )
  const guarded = { ...three, guards: 1, guardZones: [[20, 20, 21, 20]], members }
  socket.receive({ type: 'capture-runs', runs: [guarded] })
  expect(captureItems().find(({ rect }) => rect.x === zone.x && rect.y === zone.y)).toMatchObject({
    kind: 'ready',
    rect: zone,
  })
  expect(card().model?.members[2]).toMatchObject({ guard: true, drafted: 2, length: 2 })
})

/**
 * A lobby's host on an event server, with no wall locked in: planning starts on its
 * own, and the planner offers a wall along y 10 and one along y 50 with the area it would enclose.
 */
const planning = async () => {
  const { socket } = await connect({ capture: 1, scope: 'report' })
  vi.setSystemTime(TERRITORY_EVENT.startsAt + 3_600_000)
  const { captureItems, installCaptureRuns } = await import('../src/capture-runs.js')
  installCaptureRuns()
  const wall = (y: number): PlannedProposal => ({
    label: `Wall at ${y}`,
    gained: 6,
    pixels: 4,
    wall: [10, y, 11, y, 12, y, 13, y],
    guardZones: [],
    area:
      y === 50
        ? { rect: { x: 10, y, w: 4, h: 3 }, mask: new Uint8Array(12).fill(1), count: 12 }
        : null,
  })
  const [top, bottom] = [wall(10), wall(50)]
  planner.plans = [top, bottom]
  const update = (locked: PlannedProposal | null, joined: readonly string[] = []) =>
    socket.receive({ type: 'capture-runs', runs: [lobby(locked?.wall ?? null, 0, joined)] })
  update(null)
  await vi.advanceTimersByTimeAsync(0)
  return { captureItems, update, top, socket }
}

it('plans in a lobby on its own, keeping candidate masks while teammates join', async () => {
  const { captureItems, update } = await planning()
  const candidates = captureItems()
  expect(candidates.map((item) => [item.kind, item.rect.y])).toEqual([
    ['pending', 10],
    ['area', 50],
    ['pending', 50],
  ])

  update(null, ['d'.repeat(16)])
  // Same masks after a teammate joins, so the map has nothing to upload again.
  const after = captureItems()
  expect(after).toHaveLength(candidates.length)
  for (const [index, item] of after.entries()) expect(item.pixels).toBe(candidates[index]?.pixels)
})

it('lets go of the candidate masks once a wall is locked in', async () => {
  const { captureItems, update, top } = await planning()
  // Read inside a function so the test itself never holds the candidate's mask.
  const candidateLine = () => {
    const line = captureItems().find((item) => item.kind === 'pending' && item.rect.y === 50)
    expect(line?.pixels).toBeTruthy()
    return new WeakRef(line?.pixels ?? {})
  }
  const shown = candidateLine()
  // The first frame after the lock already sees the locked lobby.
  update(top)
  expect(captureItems().some((item) => item.rect.y >= 50)).toBe(false)
  // A new WeakRef holds its target until the current task ends, so collect after a real one.
  vi.useRealTimers()
  await new Promise((done) => setTimeout(done, 0))
  collect()
  expect(shown.deref()).toBeUndefined()
})

const card = () => {
  const element = document.getElementById('caelestis-capture-run') as
    | (HTMLElement & { model?: CaptureRunModel })
    | null
  if (element === null) throw new Error('Expected the capture card')
  return element
}
const intent = (detail: CaptureRunIntent) =>
  card().dispatchEvent(new CustomEvent('caelestis-capture-run-intent', { detail }))
const sent = (socket: FakeWebSocket, type: string) =>
  socket.sent.map((data) => JSON.parse(data)).filter((event) => event.type === type)

it("locks in a proposal's wall and guard zones for the lobby", async () => {
  const { top, socket } = await planning()
  // Four pixels over two painters: every leg fits, so both proposals can lock in.
  expect(card().model?.proposals.map(({ id, needs }) => [id, needs])).toEqual([
    ['10,10:13,10', 0],
    ['10,50:13,50', 0],
  ])
  intent({ type: 'lock', id: '10,10:13,10' })
  expect(sent(socket, 'capture-lock')).toEqual([
    { type: 'capture-lock', wall: top.wall, guardZones: [] },
  ])
})

it('lists the team’s lobbies to a painter in none, and joins the one they choose', async () => {
  const { socket } = await connect({ capture: 1, canWrite: true })
  vi.setSystemTime(TERRITORY_EVENT.startsAt + 3_600_000)
  const { installCaptureRuns } = await import('../src/capture-runs.js')
  installCaptureRuns()
  // The host gave the closing leg to a teammate listed first; the lobby keeps the host's name.
  const closer = { sessionId: 'd'.repeat(16), painter: { wplaceUserId: 8, displayName: 'Closer' } }
  const opened = lobby(null, 0)
  const theirs = {
    ...opened,
    opener: other.wplaceUserId,
    coordinator: closer.painter.wplaceUserId,
    host: TEAMMATE,
    members: [{ ...closer, drafted: 0 }, ...opened.members.slice(1)],
  }
  const started = { ...theirs, id: 'started', startsAt: TERRITORY_EVENT.startsAt }
  socket.receive({ type: 'capture-runs', runs: [theirs, started] })
  expect(card().model).toMatchObject({
    phase: 'list',
    lobbies: [{ id: 'run', name: other.displayName, members: 2, canJoin: true }],
  })
  intent({ type: 'join', id: 'run' })
  expect(sent(socket, 'capture-join')).toEqual([{ type: 'capture-join', run: 'run' }])
})

it("counts a leg's pixels the team already holds on Wplace's map as drafted", async () => {
  const { socket } = await connect({ capture: 1 })
  vi.setSystemTime(TERRITORY_EVENT.startsAt + 3_600_000)
  const { encodeIndexedPng, TERRITORY_ARENA, TERRITORY_TEAMS, TILE_SIZE, TRANSPARENT_INDEX } =
    await import('@caelestis/shared')
  // Wplace's map: the team already holds the first two pixels of the wall, this painter's leg.
  const size = TERRITORY_ARENA.size
  const owner = new Uint8Array(size * size).fill(TRANSPARENT_INDEX)
  owner.fill(TERRITORY_TEAMS[0].colour, 0, 2)
  const snapshot = await encodeIndexedPng(size, size, owner)
  vi.stubGlobal('fetch', async (url: unknown) =>
    String(url).endsWith('/territory/snapshot')
      ? new Response(snapshot.slice())
      : new Response(null, { status: 404 }),
  )
  const { installCaptureRuns } = await import('../src/capture-runs.js')
  installCaptureRuns()
  const left = TERRITORY_ARENA.tileX * TILE_SIZE
  const top = TERRITORY_ARENA.tileY * TILE_SIZE
  const wall = [0, 1, 2, 3].flatMap((x) => [left + x, top])
  socket.receive({ type: 'capture-runs', runs: [lobby(wall, 0)] })
  // Decoding an arena-sized map takes real time, longer under a loaded test run.
  await vi.waitFor(
    async () => {
      await vi.advanceTimersByTimeAsync(500)
      expect(sent(socket, 'capture-drafted').at(-1)).toMatchObject({ drafted: 2 })
    },
    { timeout: 10_000 },
  )

  // The server takes the report, as it would.
  const reported = lobby(wall, 0)
  const [self, ...others] = reported.members
  if (self === undefined) throw new Error('Expected this painter in the lobby')
  reported.members = [{ ...self, drafted: 2 }, ...others]
  socket.receive({ type: 'capture-runs', runs: [reported] })
  // Wplace stops answering: tries back off, and the old read stops counting once it is stale.
  let tries = 0
  vi.stubGlobal('fetch', async (url: unknown) => {
    if (String(url).endsWith('/territory/snapshot')) tries++
    throw new TypeError('Failed to fetch')
  })
  await vi.advanceTimersByTimeAsync(31_000)
  expect(tries).toBeLessThanOrEqual(8)
  expect(sent(socket, 'capture-drafted').at(-1)).toMatchObject({ drafted: 0 })
}, 20_000)

it("doesn't press Paint at a slot when nothing is drafted on the leg", async () => {
  const { socket } = await connect({ capture: 1 })
  // The slot spins out its last milliseconds on the tab's monotonic clock, so that clock runs for
  // real here; timers and the date stay fake.
  vi.useRealTimers()
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  vi.setSystemTime(TERRITORY_EVENT.startsAt + 3_600_000)
  const { setState } = await import('../src/settings.js')
  setState({ simulatedInput: { 'capture-paint': true } })
  // The territory event's Paint panel is open, its Paint button ready.
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div><button>Cancel</button><button class="btn btn-primary">Paint (0:04)</button></div>',
  )
  let clicks = 0
  document.querySelector('.btn-primary')?.addEventListener('click', () => clicks++)
  // One leg pixel is paint Wplace already accepted, not yet in a tile read: still nothing open.
  const { beginSubmission, retainAcceptedPaint } = await import('../src/tile-pixels.js')
  const { TERRITORY_TEAMS } = await import('@caelestis/shared')
  const submission = {}
  beginSubmission(submission)
  retainAcceptedPaint(
    submission,
    [{ x: 0, y: 0, pixels: { x: [10], y: [10], colors: [TERRITORY_TEAMS[0].colour] } }],
    1,
    1,
  )
  const { installCaptureRuns } = await import('../src/capture-runs.js')
  installCaptureRuns()
  const now = performance.timeOrigin + performance.now()
  const started = {
    ...lobby([10, 10, 11, 10, 12, 10, 13, 10], 0),
    startsAt: Math.round(now) + 600,
  }
  socket.receive({ type: 'capture-runs', runs: [started] })
  // Answer each clock ping at once, so the slot can be scheduled on this tab's clock.
  const answered = new Set<number>()
  for (let step = 0; step < 20; step++) {
    await vi.advanceTimersByTimeAsync(100)
    await new Promise((resolve) => setImmediate(resolve))
    for (const { sent: at } of sent(socket, 'clock')) {
      if (answered.has(at)) continue
      answered.add(at)
      socket.receive({ type: 'clock', sent: at, at })
    }
  }
  expect(clicks).toBe(0)
  // The timing log tells a skipped slot apart from one whose Paint wasn't ready.
  expect(sent(socket, 'capture-timing').map(({ status }) => status)).toEqual(['nothing-drafted'])
  document.body.replaceChildren()
  setState({ simulatedInput: {} })
})

it("says planning failed when Wplace's map cannot be fetched", async () => {
  const { socket } = await connect({ capture: 1, scope: 'report' })
  vi.setSystemTime(TERRITORY_EVENT.startsAt + 3_600_000)
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('Failed to fetch')
  })
  const { installCaptureRuns } = await import('../src/capture-runs.js')
  installCaptureRuns()
  socket.receive({ type: 'capture-runs', runs: [lobby(null, 0)] })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(card().model?.message).toBe('Planning failed. It tries again shortly.')
})

it('clears the planning failure once the same map can be read again', async () => {
  await planning()
  expect(card().model?.message).toBeUndefined()
  const working = globalThis.fetch
  // Wplace answers 503 once the cached map is due a refresh.
  vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }))
  await vi.advanceTimersByTimeAsync(6_000)
  expect(card().model?.message).toBe('Planning failed. It tries again shortly.')
  // It recovers with the same map, so the plan on screen stands.
  vi.stubGlobal('fetch', working)
  await vi.advanceTimersByTimeAsync(6_000)
  expect(card().model?.message).toBeUndefined()
})
