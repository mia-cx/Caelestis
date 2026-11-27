import { describe, expect, it } from 'vitest'
import {
  type ArenaPixel,
  borderBoxPlanner,
  chamferWall,
  NO_TEAM,
  pairLines,
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

describe('borderBoxPlanner', () => {
  it('plans a wall the group can place in pairs from both anchors, which closes', () => {
    const map = quadrantMap()
    const [plan] = borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 2, charges: 15 })
    if (plan === undefined) throw new Error('Expected a plan')
    expect(plan.lines).toHaveLength(2)
    for (const line of plan.lines) expect(line.length).toBeLessThanOrEqual(15)
    const outcome = simulateCapture(map, GREEN, plan)
    expect(outcome.refused).toBe(0)
    expect(outcome.gained).toBeGreaterThan(outcome.painted)
    // Both first lines start against green: the pair paints at the same moment.
    for (const line of plan.lines)
      expect(simulateCapture(map, GREEN, { lines: [line.slice(0, 1)] }).refused).toBe(0)
    // Each guard's zone is green's own cells past one anchor.
    expect(plan.guardZones).toHaveLength(2)
    for (const zone of plan.guardZones)
      for (const { x, y } of zone) expect(map.owner[y * SIZE + x]).toBe(GREEN)
  })

  it('returns nothing when the budget cannot close any box', () => {
    expect(
      borderBoxPlanner({ map: quadrantMap(), team: GREEN, painters: 1, guards: 0, charges: 2 }),
    ).toEqual([])
  })
})

describe('chamferWall', () => {
  // Up 30 cells, then right 30, well away from the arena edge.
  const corner: ArenaPixel[] = [
    ...Array.from({ length: 31 }, (_, i) => ({ x: 50, y: 100 - i })),
    ...Array.from({ length: 30 }, (_, i) => ({ x: 51 + i, y: 70 })),
  ]

  it('turns an exposed corner into a 45 degree staircase with the same pixel count', () => {
    const wall = chamferWall(corner, 200)
    expect(wall).toHaveLength(corner.length)
    expect(wall).not.toContainEqual({ x: 50, y: 70 })
    expect(wall[0]).toEqual(corner[0])
    expect(wall.at(-1)).toEqual(corner.at(-1))
    for (let i = 1; i < wall.length; i++) {
      const a = wall[i - 1] as ArenaPixel
      const b = wall[i] as ArenaPixel
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1)
    }
  })

  it('leaves a corner on the arena edge square, since only one side can reach it', () => {
    const onEdge = corner.map(({ x, y }) => ({ x: x - 50, y }))
    expect(chamferWall(onEdge, 200)).toEqual(onEdge)
  })
})

describe('pairLines', () => {
  const wall = Array.from({ length: 130 }, (_, x) => ({ x, y: 0 }))

  it('alternates anchors, each B-line starting beside the one before it', () => {
    const [a1, b1, a2] = pairLines(wall, 3, 60)
    expect(a1?.[0]).toEqual({ x: 0, y: 0 })
    expect(b1?.[0]).toEqual({ x: 129, y: 0 })
    expect(a2).toEqual(wall.slice(60, 70))
  })

  it('gives every painter a line, empty once the wall runs out', () => {
    expect(pairLines(wall, 4, 60).map((line) => line.length)).toEqual([60, 60, 10, 0])
  })
})
