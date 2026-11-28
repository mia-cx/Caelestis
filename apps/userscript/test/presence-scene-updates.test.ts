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

/**
 * An event runner on an event server, in a lobby with no wall locked in: planning starts on its
 * own, and the planner offers a wall along y 10 and one along y 50 with the area it would enclose.
 */
const planning = async () => {
  const { socket } = await connect({ capture: 1, scope: 'event_runner' })
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
  // The opener gave the closing leg to a teammate listed first; the lobby keeps the opener's name.
  const closer = { sessionId: 'd'.repeat(16), painter: { wplaceUserId: 8, displayName: 'Closer' } }
  const opened = lobby(null, 0)
  const theirs = {
    ...opened,
    opener: other.wplaceUserId,
    coordinator: closer.painter.wplaceUserId,
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
  await vi.waitFor(async () => {
    await vi.advanceTimersByTimeAsync(500)
    expect(sent(socket, 'capture-drafted').at(-1)).toMatchObject({ drafted: 2 })
  })
})
