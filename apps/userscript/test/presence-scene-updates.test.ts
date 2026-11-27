import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { type PresenceRect, TERRITORY_EVENT } from '@caelestis/shared'
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

it('redraws capture lines from every run update and reuses them between updates', async () => {
  const { socket } = await connect({ capture: 1 })
  const { captureItems } = await import('../src/capture-runs.js')
  const run = (drafted: number) =>
    socket.receive({
      type: 'capture',
      run: {
        id: 'run',
        team: 0,
        painters: 2,
        guards: 0,
        startsAt: null,
        staggerMs: 500,
        members: [
          { sessionId: SELF_SESSION, painter, drafted: 0 },
          { sessionId: 'c'.repeat(16), painter: other, drafted },
        ],
        lines: [
          [10, 10, 11, 10],
          [10, 12, 11, 12],
        ],
      },
    })
  run(0)
  const gathering = captureItems()
  // The other painter's line is outlined until drafted; this painter's own is still to draft.
  expect(gathering.map((item) => item.kind)).toEqual(['pending', 'todo'])
  expect(captureItems()).toBe(gathering)
  run(2)
  expect(captureItems().map((item) => item.kind)).toEqual(['ready', 'todo'])
})

/**
 * An administrator on an event server whose gathering run has the top wall published, asking for
 * plans again: the planner offers the top wall and a bottom one, so the bottom one is the candidate.
 */
const proposeAgain = async () => {
  const { socket } = await connect({ capture: 1, admin: true })
  vi.setSystemTime(TERRITORY_EVENT.startsAt + 3_600_000)
  const { captureItems, installCaptureRuns } = await import('../src/capture-runs.js')
  installCaptureRuns()
  // Two walls the planner offers: one along y 10, one along y 50 with the area it would enclose.
  const wall = (y: number): PlannedProposal => ({
    label: `Wall at ${y}`,
    gained: 6,
    pixels: 4,
    lines: [
      [10, y, 11, y],
      [10, y + 2, 11, y + 2],
    ],
    area:
      y === 50
        ? { rect: { x: 10, y, w: 2, h: 3 }, mask: new Uint8Array(6).fill(1), count: 6 }
        : null,
  })
  const [top, bottom] = [wall(10), wall(50)]
  planner.plans = [top, bottom]
  const run = (published: PlannedProposal, drafted: number, startsAt: number | null = null) =>
    socket.receive({
      type: 'capture',
      run: {
        id: 'run',
        team: 0,
        painters: 2,
        guards: 0,
        startsAt,
        staggerMs: 500,
        members: [
          { sessionId: 'c'.repeat(16), painter: other, drafted },
          { sessionId: 'd'.repeat(16), painter: other, drafted: 0 },
        ],
        lines: published.lines,
      },
    })
  const intent = (type: 'propose' | 'go') =>
    document
      .getElementById('caelestis-capture-run')
      ?.dispatchEvent(new CustomEvent('caelestis-capture-run-intent', { detail: { type } }))
  run(top, 0)
  intent('propose')
  await vi.advanceTimersByTimeAsync(0)
  return { captureItems, run, intent, top, bottom }
}

it("keeps candidate masks across a teammate's progress, and follows the published plan", async () => {
  const { captureItems, run, top, bottom } = await proposeAgain()
  const below = (y: number) => captureItems().filter((item) => item.rect.y >= y)
  const candidates = below(50)
  expect(candidates.map((item) => item.kind)).toEqual(['area', 'pending', 'pending'])

  run(top, 1)
  // Same masks after a progress update, so the map has nothing to upload again.
  const after = below(50)
  expect(after).toHaveLength(candidates.length)
  for (const [index, item] of after.entries()) expect(item.pixels).toBe(candidates[index]?.pixels)

  // Publishing the bottom wall instead shows the top one as the candidate.
  run(bottom, 1)
  const above = captureItems().filter((item) => item.rect.y < 50)
  expect(above.map((item) => [item.kind, item.rect.y])).toEqual([
    ['pending', 10],
    ['pending', 12],
  ])
})

it('lets go of the candidate masks once the run starts', async () => {
  const { captureItems, run, intent, top } = await proposeAgain()
  // Read inside a function so the test itself never holds the candidate's mask.
  const candidateLine = () => {
    const line = captureItems().find((item) => item.kind === 'pending' && item.rect.y === 50)
    expect(line?.pixels).toBeTruthy()
    return new WeakRef(line?.pixels ?? {})
  }
  const shown = candidateLine()
  intent('go')
  // The first frame after Go already sees the started run.
  run(top, 2, TERRITORY_EVENT.startsAt + 3_660_000)
  expect(captureItems().some((item) => item.rect.y >= 50)).toBe(false)
  // A new WeakRef holds its target until the current task ends, so collect after a real one.
  vi.useRealTimers()
  await new Promise((done) => setTimeout(done, 0))
  collect()
  expect(shown.deref()).toBeUndefined()
})
