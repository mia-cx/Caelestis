import {
  arenaToWorld,
  CAPTURE_RECESS,
  type CaptureRun,
  GUARD_MARGIN,
  NO_TEAM,
  type TerritoryMap,
} from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  anchorRects,
  anchorWatch,
  approachPath,
  caterpillarFrames,
  enclosedArea,
} from './capture-scene.js'

const GREEN = 2
const SIZE = 40

/** Green holds the arena's bottom-right quadrant. */
const quadrant = (): TerritoryMap => {
  const owner = new Uint8Array(SIZE * SIZE).fill(NO_TEAM)
  for (let y = SIZE / 2; y < SIZE; y++)
    for (let x = SIZE / 2; x < SIZE; x++) owner[y * SIZE + x] = GREEN
  return { size: SIZE, owner }
}

const world = (x: number, y: number) => arenaToWorld({ x, y })
const touching = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1

describe('approachPath', () => {
  it('runs from next to the territory to beside the line, one side-step at a time', () => {
    const line = world(14, 25)
    const path = approachPath(quadrant(), GREEN, line)
    // Five pixels from x 19 (beside green at x 20) to x 15 (beside the line at x 14).
    expect(path).toEqual([19, 18, 17, 16, 15].map((x) => world(x, 25)))
  })
})

describe('caterpillarFrames', () => {
  const path = [19, 18, 17, 16, 15, 14, 13, 12].map((x) => world(x, 25))
  const line = [11, 10, 9].map((x) => world(x, 25))

  it("never lets the chain break, and ends on the line's first pixel without covering the rest", () => {
    const frames = caterpillarFrames(path, line)
    for (const frame of frames)
      for (let at = 1; at < frame.length; at++)
        expect(
          touching(
            frame[at - 1] as { x: number; y: number },
            frame[at] as { x: number; y: number },
          ),
        ).toBe(true)
    // The chain is at most five long, so it fits in a painter's charges.
    expect(Math.max(...frames.map((frame) => frame.length))).toBeLessThanOrEqual(5)
    expect(frames.at(-1)).toEqual([line[0]])
  })

  it('plays nothing for a line that already touches the territory', () => {
    expect(caterpillarFrames([], line)).toEqual([])
  })
})

describe('enclosedArea', () => {
  it('hatches what a closed wall takes, and not the wall', () => {
    const hook = [
      [20, 19],
      [20, 18],
      [20, 17],
      [21, 17],
      [22, 17],
      [22, 18],
      [22, 19],
    ].flatMap(([x, y]) => {
      const pixel = world(x as number, y as number)
      return [pixel.x, pixel.y]
    })
    const area = enclosedArea(quadrant(), GREEN, [hook])
    expect(area?.count).toBe(2)
  })
})

describe('the guard’s anchor', () => {
  // A painter and a guard, on a straight 40-pixel wall whose ends reach into the territory.
  const wall = Array.from({ length: 40 }, (_, x) => [1000 + x, 2000]).flat()
  const run: CaptureRun = {
    id: 'run',
    team: GREEN,
    coordinator: 1,
    painters: 1,
    guards: 1,
    distribution: 'even',
    members: [1, 2].map((id) => ({
      sessionId: `s${id}`,
      painter: { wplaceUserId: id, displayName: `Painter ${id}` },
      drafted: 0,
    })),
    wall,
    guardZones: [[]],
    startsAt: null,
    staggerMs: 500,
    cut: 0,
  }
  const guard = 1
  const at = (index: number) => ({ x: wall[index * 2], y: wall[index * 2 + 1] })

  it('watches the recess and the first pixels painted from each anchor', () => {
    const watched = anchorWatch(run, guard, GUARD_MARGIN)
    const deepest = CAPTURE_RECESS + GUARD_MARGIN - 1
    expect(watched).toContainEqual(at(0))
    expect(watched).toContainEqual(at(deepest))
    expect(watched).toContainEqual(at(39 - deepest))
    expect(watched).not.toContainEqual(at(deepest + 1))
  })

  it('boxes the first pixel painted from each anchor, past the recess', () => {
    const centres = anchorRects(run, guard, GUARD_MARGIN).map(({ x, y }) => ({
      x: x + GUARD_MARGIN,
      y: y + GUARD_MARGIN,
    }))
    expect(centres).toEqual([at(CAPTURE_RECESS), at(39 - CAPTURE_RECESS)])
  })
})
