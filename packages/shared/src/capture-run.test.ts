import { describe, expect, it } from 'vitest'
import { packBits } from './bitmask.js'
import {
  CAPTURE_LEAD_MS,
  type CaptureRun,
  captureEndsAt,
  captureGuardCount,
  captureLead,
  captureLegsDrafted,
  captureLines,
  captureReady,
  captureShortfall,
  captureSlot,
  captureWallDrafted,
  DEFAULT_CAPTURE_SETTINGS,
  decodeCaptureRun,
  isCaptureReserve,
  MAX_CAPTURE_LINE_PIXELS,
  MAX_CAPTURE_MEMBERS,
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

/** `covered` for a wall of `pixels`, with the wall pixels from `from` up to `to` drafted. */
const covering = (pixels: number, from: number, to: number) =>
  packBits(Uint8Array.from({ length: pixels }, (_, at) => (at >= from && at < to ? 1 : 0)))

/** The lobby with member `index` reporting `covered`. */
const reporting = (run: CaptureRun, index: number, covered: string): CaptureRun => ({
  ...run,
  members: run.members.with(index, { ...(run.members[index] ?? member(0)), covered }),
})

describe('the wall drafted', () => {
  it('holds the start until every painter’s leg is drafted, whatever the guards have', () => {
    // Two painters with 20-pixel legs, and a guard; tabs that only report their own leg.
    expect(captureWallDrafted(lobby(40, [20, 19, 2]))).toBe(false)
    expect(captureWallDrafted(lobby(40, [20, 20, 0]))).toBe(true)
  })

  it('counts a leg drafted by someone other than its painter', () => {
    // The first painter drafts the whole wall; the second has drafted nothing of their own leg.
    const run = reporting(lobby(40, [20, 0], 0), 0, covering(40, 0, 40))
    expect(captureLegsDrafted(run)).toEqual([20, 20])
    expect(captureReady(run)).toBe(true)
  })

  it('counts a pixel two painters drafted once, and the rest of the wall still holds the start', () => {
    // Both draft the first 30 pixels, overlapping on 10..30; nobody has the last 10.
    const both = reporting(
      reporting(lobby(40, [20, 10], 0), 0, covering(40, 0, 30)),
      1,
      covering(40, 10, 30),
    )
    expect(captureLegsDrafted(both)).toEqual([20, 10])
    expect(captureReady(both)).toBe(false)
  })

  it('credits a tab that only counts its own leg once it covers all of it', () => {
    // The second painter's tab predates `covered`: 19 of 20 says nothing of which pixels.
    const partly = reporting(lobby(40, [20, 19], 0), 0, covering(40, 0, 20))
    expect(captureReady(partly)).toBe(false)
    const fully = reporting(lobby(40, [20, 20], 0), 0, covering(40, 0, 20))
    expect(captureReady(fully)).toBe(true)
  })

  it('counts nothing a reserve drafts, since a reserve never presses Paint', () => {
    // One 40-pixel leg and a reserve; only the reserve has drafted, all of it.
    const run: CaptureRun = { ...lobby(40, [0, 0], 0), distribution: 'reserve' }
    expect(captureReady(reporting(run, 1, covering(40, 0, 40)))).toBe(false)
    expect(captureReady({ ...run, members: [member(1, 40), member(2)] })).toBe(true)
  })

  it('ignores a coverage that doesn’t fit the wall', () => {
    expect(captureWallDrafted(reporting(lobby(40, [0, 0], 0), 0, covering(48, 0, 48)))).toBe(false)
  })
})

describe('Wait for Ready', () => {
  /** A drafted lobby of two painters and a guard, with their Ready as given. */
  const drafted = (ready: readonly (boolean | undefined)[]): CaptureRun => {
    const run = lobby(40, [20, 20, 0])
    return {
      ...run,
      waitForReady: true,
      members: run.members.map((entry, index) => {
        const pressed = ready[index]
        return pressed === undefined ? entry : { ...entry, ready: pressed }
      }),
    }
  }

  it('holds the start until everyone who paints at a slot is Ready, the guard too', () => {
    expect(captureReady(drafted([true, true, false]))).toBe(false)
    expect(captureReady(drafted([true, true, true]))).toBe(true)
    // Off, nobody's Ready holds it.
    const { waitForReady: _, ...off } = drafted([false, false, false])
    expect(captureReady(off)).toBe(true)
  })

  it('never waits for a tab with no Ready button, or a reserve', () => {
    expect(captureReady(drafted([true, undefined, true]))).toBe(true)
    const reserved: CaptureRun = {
      ...lobby(40, [40, 0], 0),
      distribution: 'reserve',
      waitForReady: true,
    }
    const members = reserved.members.map((entry, index) => ({ ...entry, ready: index === 0 }))
    expect(captureReady({ ...reserved, members })).toBe(true)
  })
})

it('holds the start for a leg or guard zone left empty, but not for a reserve’s place', () => {
  const left = (run: CaptureRun, index: number): CaptureRun => ({
    ...run,
    members: run.members.map((entry, at) => (at === index ? { ...entry, left: true } : entry)),
  })
  const painted = lobby(40, [20, 20, 2])
  expect(captureReady(left(painted, 0))).toBe(false)
  expect(captureReady(left(painted, 2))).toBe(false)
  // One 40-pixel leg in reserve, and a reserve who left.
  const reserved: CaptureRun = { ...lobby(40, [40, 0], 0), distribution: 'reserve' }
  expect(captureReady(left(reserved, 1))).toBe(true)
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

it('decodes who waits for the next lock-in, up to the most members a lobby holds', () => {
  const run: CaptureRun = { ...lobby(40, [0, 0]), waiting: [member(3)] }
  expect(decodeCaptureRun(JSON.parse(JSON.stringify(run)))).toEqual(run)
  const crowd = Array.from({ length: MAX_CAPTURE_MEMBERS - 1 }, (_, index) => member(index + 3))
  expect(decodeCaptureRun({ ...run, waiting: crowd })).toBeNull()
})

it('decodes what members drafted of the wall, their Ready, and Wait for Ready', () => {
  const base = lobby(40, [0, 0])
  const run: CaptureRun = {
    ...base,
    waitForReady: true,
    members: [{ ...member(1), covered: covering(40, 0, 20), ready: true }, member(2)],
  }
  expect(decodeCaptureRun(JSON.parse(JSON.stringify(run)))).toEqual(run)
  expect(decodeCaptureRun({ ...run, waitForReady: false })).toBeNull()
  expect(decodeCaptureRun({ ...base, members: [{ ...member(1), ready: 'yes' }] })).toBeNull()
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
        waitForReady: 'yes',
      }),
    ).toEqual({
      painters: MAX_CAPTURE_PAINTERS,
      guards: 0,
      staggerMs: 500,
      leadMs: 5_000,
      distribution: 'reserve',
      waitForReady: false,
    })
    expect(normaliseCaptureSettings({ waitForReady: true }).waitForReady).toBe(true)
  })
})
