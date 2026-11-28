import { describe, expect, it } from 'vitest'
import {
  type CaptureRun,
  captureLines,
  capturePaintersDrafted,
  captureShortfall,
} from './capture-run.js'

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
  coordinator: 1,
  painters: 3,
  guards,
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
