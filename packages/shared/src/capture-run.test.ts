import { describe, expect, it } from 'vitest'
import {
  CAPTURE_LEAD_MS,
  type CaptureRun,
  captureEndsAt,
  captureGuardCount,
  captureLead,
  captureLines,
  capturePaintersDrafted,
  captureShortfall,
  captureSlot,
  DEFAULT_CAPTURE_SETTINGS,
  decodeCaptureRun,
  isCaptureReserve,
  MAX_CAPTURE_LINE_PIXELS,
  MAX_CAPTURE_PAINTERS,
  MAX_CAPTURE_WALL_PIXELS,
  normaliseCaptureSettings,
} from './capture-run.js'
import { MAX_PRESENCE_MESSAGE_CODE_UNITS } from './presence.js'
import { WORLD_PIXELS } from './tiles.js'

const member = (id: number, drafted = 0) => ({
  sessionId: `s${id}`,
  painter: { wplaceUserId: id, displayName: `Painter ${id}` },
  drafted,
})

/** A straight wall of `pixels` along y 0, from anchor A at x 0 to anchor B at the far end. */
const wall = (pixels: number) => Array.from({ length: pixels }, (_, x) => [x, 0]).flat()
const xs = (line: readonly number[] | undefined) => (line ?? []).filter((_, at) => at % 2 === 0)

/** A lobby with one guard zone locked in, its members drafted as given. */
const lobby = (pixels: number, drafted: readonly number[], guards = 1): CaptureRun => ({
  id: 'run',
  team: 2,
  opener: 1,
  coordinator: 1,
  painters: 3,
  guards,
  distribution: 'even',
  members: drafted.map((count, index) => member(index + 1, count)),
  wall: wall(pixels),
  guardZones: guards === 0 ? [] : [[0, 1, 1, 1]],
  startsAt: null,
  staggerMs: 500,
  cut: 0,
})

describe('captureLines', () => {
  it('cuts the wall into one leg per painting member, in pairs from both anchors', () => {
    const [a1, b1, a2, guard] = captureLines(lobby(130, [0, 0, 0, 0]))
    // A-legs run inward from A, B-legs inward from B, so each starts against the leg before it.
    expect(xs(a1)).toEqual(Array.from({ length: 44 }, (_, x) => x))
    expect(xs(b1)).toEqual(Array.from({ length: 43 }, (_, k) => 129 - k))
    // The closing leg is the middle, between where A1 and B1 stop.
    expect(xs(a2)).toEqual(Array.from({ length: 43 }, (_, k) => 44 + k))
    // The last member guards, with the zone locked in beside the wall.
    expect(guard).toEqual([0, 1, 1, 1])
  })

  it('gives more painters shorter legs', () => {
    const legs = (members: number) =>
      captureLines(lobby(130, Array(members).fill(0), 0)).map((line) => line.length / 2)
    expect(legs(3)).toEqual([44, 43, 43])
    expect(legs(5)).toEqual([26, 26, 26, 26, 26])
  })

  it('keeps one painter in a lobby smaller than its guards', () => {
    const lines = captureLines(lobby(40, [0], 2))
    expect(lines.map((line) => line.length / 2)).toEqual([40])
  })

  it('cuts the fewest legs that fit in reserve, and leaves the painters past them none', () => {
    // 130 pixels fit three 60-pixel legs; of five painters, the last two stand by.
    const run: CaptureRun = { ...lobby(130, [0, 0, 0, 0, 0], 0), distribution: 'reserve' }
    expect(captureLines(run).map((line) => line.length / 2)).toEqual([44, 43, 43, 0, 0])
    expect([0, 1, 2, 3, 4].map((index) => isCaptureReserve(run, index))).toEqual([
      false,
      false,
      false,
      true,
      true,
    ])
    // Reserves get no slot, and the wall closes with the third leg.
    const started = { ...run, startsAt: 10_000 }
    expect([0, 1, 2, 3, 4].map((index) => captureSlot(started, index))).toEqual([
      10_000,
      10_000,
      10_500,
      null,
      null,
    ])
    expect(captureEndsAt(started)).toBe(10_500)
  })

  it('cuts a leg per painter in reserve until a wall is locked in', () => {
    const run: CaptureRun = { ...lobby(130, [0, 0, 0, 0], 0), distribution: 'reserve', wall: null }
    expect([0, 1, 2, 3].some((index) => isCaptureReserve(run, index))).toBe(false)
  })

  it('cuts nothing until a wall is locked in', () => {
    expect(captureLines({ ...lobby(40, [0, 0]), wall: null })).toEqual([])
  })
})

it('counts the painters a wall still needs so no leg exceeds 60 pixels', () => {
  expect(captureShortfall(120, 2)).toBe(0)
  expect(captureShortfall(121, 2)).toBe(1)
  expect(captureShortfall(300, 2)).toBe(3)
})

it('holds the start until every painter has drafted their leg, whatever the guards have', () => {
  // Two painters with 20-pixel legs, and a guard.
  expect(capturePaintersDrafted(lobby(40, [20, 19, 2]))).toBe(false)
  expect(capturePaintersDrafted(lobby(40, [20, 20, 0]))).toBe(true)
})

it("doesn't hold the start for reserves", () => {
  // One 40-pixel leg, drafted, and two reserves who have drafted nothing.
  const run: CaptureRun = { ...lobby(40, [40, 0, 0], 0), distribution: 'reserve' }
  expect(capturePaintersDrafted(run)).toBe(true)
})

it('lets at most half the lobby guard, rounded down', () => {
  // More guards than any of these lobbies may have.
  const MAX_GUARDS_ASKED = 10
  const guarding = (members: number) =>
    captureGuardCount(lobby(40, Array(members).fill(0), MAX_GUARDS_ASKED))
  expect([1, 2, 3, 6, 7].map(guarding)).toEqual([0, 1, 1, 3, 3])
})

it('fits the largest lock-in in one presence message', () => {
  // Every coordinate at its widest: a full wall and the most guards, each zone at a leg's size.
  const far = WORLD_PIXELS - 1
  const line = (pixels: number) => Array(pixels * 2).fill(far)
  const lockIn = JSON.stringify({
    type: 'capture-lock',
    wall: line(MAX_CAPTURE_WALL_PIXELS),
    guardZones: Array.from({ length: MAX_CAPTURE_PAINTERS }, () => line(MAX_CAPTURE_LINE_PIXELS)),
  })
  expect(lockIn.length).toBeLessThanOrEqual(MAX_PRESENCE_MESSAGE_CODE_UNITS)
})

it('decodes a lobby stored before its opener or lead was recorded', () => {
  // Backend 1.5.0 stored lobbies without `opener` or `leadMs`; one still open after an upgrade
  // must decode, and counts down for the default lead.
  const { opener: _, ...stored } = lobby(40, [0, 0])
  const decoded = decodeCaptureRun(JSON.parse(JSON.stringify(stored)))
  expect(decoded).toEqual(stored)
  expect(decoded === null ? null : captureLead(decoded)).toBe(CAPTURE_LEAD_MS)
  const withLead = { ...stored, leadMs: 4_000 }
  expect(decodeCaptureRun(withLead)).toEqual(withLead)
})

describe('normaliseCaptureSettings', () => {
  it('counts down 10 s by default, from 3 s to 30 s in whole seconds', () => {
    expect(normaliseCaptureSettings(undefined)).toEqual(DEFAULT_CAPTURE_SETTINGS)
    expect(DEFAULT_CAPTURE_SETTINGS.leadMs).toBe(10_000)
    const lead = (leadMs: unknown) => normaliseCaptureSettings({ leadMs }).leadMs
    expect([1_000, 3_000, 4_400, 30_000, 45_000, 'soon'].map(lead)).toEqual([
      3_000, 3_000, 4_000, 30_000, 30_000, 10_000,
    ])
  })

  it('keeps every stored setting within its bounds', () => {
    expect(
      normaliseCaptureSettings({
        painters: 40,
        guards: -1,
        staggerMs: 520,
        leadMs: 5_000,
        distribution: 'reserve',
      }),
    ).toEqual({
      painters: MAX_CAPTURE_PAINTERS,
      guards: 0,
      staggerMs: 500,
      leadMs: 5_000,
      distribution: 'reserve',
    })
  })
})
