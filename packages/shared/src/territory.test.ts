import { describe, expect, it } from 'vitest'
import {
  type ArenaPixel,
  edgeRectanglePlanner,
  NO_TEAM,
  simulateCapture,
  type TerritoryMap,
} from './territory.js'

const GREEN = 2
const SIZE = 40

/** Green holds the bottom-right quadrant of a small arena, as it starts in the real one. */
const quadrantMap = (): TerritoryMap => {
  const owner = new Uint8Array(SIZE * SIZE).fill(NO_TEAM)
  for (let y = SIZE / 2; y < SIZE; y++)
    for (let x = SIZE / 2; x < SIZE; x++) owner[y * SIZE + x] = GREEN
  return { size: SIZE, owner }
}

const run = (...points: [number, number][]): ArenaPixel[] => points.map(([x, y]) => ({ x, y }))

describe('simulateCapture', () => {
  it('refuses a pixel that touches the team only diagonally', () => {
    const outcome = simulateCapture(quadrantMap(), GREEN, { lines: [run([19, 19])] })
    expect(outcome).toMatchObject({ painted: 0, refused: 1, gained: 0 })
  })

  it('takes the area a wall encloses against the team', () => {
    // A 3x3 hook out of green's top edge encloses the one pixel between it and the border.
    const wall = run([20, 19], [20, 18], [20, 17], [21, 17], [22, 17], [22, 18], [22, 19])
    const outcome = simulateCapture(quadrantMap(), GREEN, { lines: [wall] })
    expect(outcome).toMatchObject({ painted: 7, refused: 0, gained: 9 })
  })

  it('leaves an area open where it touches the arena edge, which is no wall', () => {
    // The same hook against the right edge, open on that side.
    const wall = run([38, 19], [38, 18], [38, 17], [39, 17])
    const outcome = simulateCapture(quadrantMap(), GREEN, { lines: [wall] })
    expect(outcome.gained).toBe(4)
  })
})

describe('edgeRectanglePlanner', () => {
  it('plans walls each painter can place in turn that close and enclose territory', () => {
    const map = quadrantMap()
    const plans = edgeRectanglePlanner({ map, team: GREEN, painters: 2, charges: 15 })
    expect(plans).toHaveLength(2)
    for (const plan of plans) {
      expect(plan.lines.length).toBeLessThanOrEqual(2)
      for (const line of plan.lines) expect(line.length).toBeLessThanOrEqual(15)
      const outcome = simulateCapture(map, GREEN, plan)
      expect(outcome.refused).toBe(0)
      expect(outcome.gained).toBeGreaterThan(outcome.painted * 4)
    }
  })
})
