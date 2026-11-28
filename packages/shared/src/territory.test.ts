import { describe, expect, it } from 'vitest'
import {
  type ArenaPixel,
  arenaToWorld,
  borderBoxPlanner,
  type CapturePlan,
  chamferWall,
  NO_TEAM,
  pairLines,
  simulateCapture,
  type TerritoryMap,
  worldToArena,
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

/** A map of `size` where Green holds the cells `own` picks. */
const greenWhere = (size: number, own: (x: number, y: number) => boolean): TerritoryMap => {
  const owner = new Uint8Array(size * size).fill(NO_TEAM)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if (own(x, y)) owner[y * size + x] = GREEN
  return { size, owner }
}

describe('borderBoxPlanner', () => {
  it("starts each guard's zone on the team's cells beside the anchor, also at a stepped border", () => {
    // Green's top border steps between y 60 and y 50 every ten columns.
    const map = greenWhere(120, (x, y) => y >= (Math.floor(x / 10) % 2 === 0 ? 60 : 50))
    const [plan] = borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 2, charges: 60 })
    if (plan === undefined) throw new Error('Expected a plan')
    for (const zone of plan.guardZones) {
      expect(zone.length).toBeGreaterThan(0)
      for (const { x, y } of zone) expect(map.owner[y * 120 + x]).toBe(GREEN)
    }
  })

  it('ends each leg on the border at its own line, spending the whole budget on a stepped border', () => {
    // Green's top border drops from y 70 to y 120 at x 100.
    const map = greenWhere(200, (x, y) => y >= (x < 100 ? 70 : 120))
    const [plan] = borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 2, charges: 60 })
    if (plan === undefined) throw new Error('Expected a plan')
    const outcome = simulateCapture(map, GREEN, plan)
    expect(outcome).toMatchObject({ painted: 120, refused: 0 })
    // Legs that end on one line put both anchors on one row or column; these share neither.
    const [a, b] = plan.lines.map((line) => line[0] as ArenaPixel)
    if (a === undefined || b === undefined) throw new Error('Expected two lines')
    expect(a.x === b.x || a.y === b.y).toBe(false)
    // A box with equal legs L and far side W, 2L + W = budget, wins at most budget² / 8 plus its
    // own pixels: 16 per pixel here.
    expect(outcome.gained / outcome.painted).toBeGreaterThan(120 / 8 + 1)
    // Each guard's zone starts on the team's cell beside its anchor.
    plan.guardZones.forEach((zone, k) => {
      const anchor = k === 0 ? a : b
      const first = zone[0] as ArenaPixel
      expect(Math.abs(first.x - anchor.x) + Math.abs(first.y - anchor.y)).toBe(1)
      for (const { x, y } of zone) expect(map.owner[y * 200 + x]).toBe(GREEN)
    })
  })

  it('gives each of many guards their own zone, alternating between the anchors', () => {
    const map = greenWhere(200, (x, y) => y >= (x < 100 ? 70 : 120))
    const [plan] = borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 5, charges: 60 })
    if (plan === undefined) throw new Error('Expected a plan')
    const anchors = plan.lines.map((line) => line[0] as ArenaPixel)
    const near = (pixel: ArenaPixel, anchor: ArenaPixel | undefined) =>
      anchor === undefined ? Infinity : Math.abs(pixel.x - anchor.x) + Math.abs(pixel.y - anchor.y)
    expect(plan.guardZones).toHaveLength(5)
    const cells = plan.guardZones.flat().map(({ x, y }) => y * 200 + x)
    expect(new Set(cells).size).toBe(cells.length)
    plan.guardZones.forEach((zone, k) => {
      expect(zone.length).toBeGreaterThan(0)
      expect(zone.length).toBeLessThanOrEqual(60)
      // Guards 0, 2 and 4 hold anchor A; 1 and 3 hold B.
      const [own, other] = k % 2 === 0 ? anchors : [...anchors].reverse()
      for (const pixel of zone) {
        expect(map.owner[pixel.y * 200 + pixel.x]).toBe(GREEN)
        expect(near(pixel, own)).toBeLessThan(near(pixel, other))
      }
    })
  })

  it('keeps the whole wall within the budget when a chamfer would cost more', () => {
    // A thin Green arm reaches up from the base and along row 37, so a chamfered corner would
    // trade the arm's cells for ones to paint.
    const map = greenWhere(
      160,
      (x, y) =>
        y >= 65 ||
        (y === 37 && x >= 42 && x <= 60) ||
        (y >= 38 &&
          y <= 64 &&
          (x === 42 - Math.floor((y - 37) / 3) || x === 42 - Math.floor((y - 38) / 3))),
    )
    for (const plan of borderBoxPlanner({
      map,
      team: GREEN,
      painters: 2,
      guards: 0,
      charges: 60,
    })) {
      const outcome = simulateCapture(map, GREEN, plan)
      expect(outcome.gained).toBeGreaterThan(outcome.painted)
    }
  })

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

  it('reaches the arena edge across specks of the team on a ragged border', () => {
    const map = quadrantMap()
    for (const x of [15, 17]) map.owner[(SIZE - 1) * SIZE + x] = GREEN
    const [plan] = borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 0, charges: 15 })
    if (plan === undefined) throw new Error('Expected a plan')
    const cells = plan.lines.flat()
    expect(cells.some(({ y }) => y === SIZE - 1)).toBe(true)
    for (const { x, y } of cells) expect(map.owner[y * SIZE + x]).not.toBe(GREEN)
    expect(simulateCapture(map, GREEN, plan).refused).toBe(0)
  })

  it('proposes only walls around the focus pixel', () => {
    const request = {
      map: quadrantMap(),
      team: GREEN,
      painters: 2,
      guards: 0,
      charges: 15,
    } as const
    const focus = { x: 30, y: 17 }
    const plans = borderBoxPlanner({ ...request, focus })
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) {
      const cells = plan.lines.flat()
      const xs = cells.map(({ x }) => x)
      const ys = cells.map(({ y }) => y)
      expect(focus.x).toBeGreaterThanOrEqual(Math.min(...xs))
      expect(focus.x).toBeLessThanOrEqual(Math.max(...xs))
      expect(focus.y).toBeGreaterThanOrEqual(Math.min(...ys))
      expect(focus.y).toBeLessThanOrEqual(Math.max(...ys))
    }
    expect(borderBoxPlanner({ ...request, focus: { x: 2, y: 2 } })).toEqual([])
  })

  it('plans around the view centre, which falls between pixels', () => {
    const world = arenaToWorld({ x: 30, y: 17 })
    const focus = worldToArena({ x: world.x + 0.4, y: world.y + 0.6 })
    if (focus === null) throw new Error('Expected the centre inside the arena')
    const request = {
      map: quadrantMap(),
      team: GREEN,
      painters: 1,
      guards: 1,
      charges: 60,
    } as const
    expect(borderBoxPlanner({ ...request, focus })).toEqual(
      borderBoxPlanner({ ...request, focus: { x: 30, y: 17 } }),
    )
    expect(borderBoxPlanner({ ...request, focus }).length).toBeGreaterThan(0)
  })

  it('skips a wall whose chamfered corner cuts the focus out', () => {
    const map = greenWhere(180, (_, y) => y >= 90)
    const focus = { x: 40, y: 54 }
    const plans = borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 0, charges: 60, focus })
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans)
      expect(simulateCapture(map, GREEN, plan).map.owner[focus.y * 180 + focus.x]).toBe(GREEN)
  })

  /** Every plan paints without refusals and leaves `focus` the team's. */
  const expectHeld = (map: TerritoryMap, focus: ArenaPixel, plans: readonly CapturePlan[]) => {
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) {
      const outcome = simulateCapture(map, GREEN, plan)
      expect(outcome.refused).toBe(0)
      expect(outcome.gained).toBeGreaterThan(outcome.painted)
      expect(outcome.map.owner[focus.y * map.size + focus.x]).toBe(GREEN)
    }
  }

  it('proposes a wall that paints the focus itself, also on the arena edge', () => {
    const map = greenWhere(200, (x, y) => x >= 100 && y >= 100)
    const focus = { x: 199, y: 90 }
    expectHeld(
      map,
      focus,
      borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 0, charges: 60, focus }),
    )
  })

  it('falls back to an overlapping wall when the best estimate leaks', () => {
    // A shelf at y 40 to 47 overhangs open ground, so a leg that stops on it leaves a way out.
    const map = greenWhere(
      160,
      (x, y) => y >= 110 || (x >= 150 && y >= 40) || (x >= 45 && y >= 40 && y < 48),
    )
    const focus = { x: 48, y: 29 }
    expectHeld(
      map,
      focus,
      borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 0, charges: 60, focus }),
    )
  })

  /** A map of `size` where Green holds these inclusive `[x0, y0, x1, y1]` rectangles. */
  const greenRects = (size: number, rects: readonly (readonly number[])[]) =>
    greenWhere(size, (x, y) =>
      rects.some(([x0 = 0, y0 = 0, x1 = 0, y1 = 0]) => x >= x0 && x <= x1 && y >= y0 && y <= y1),
    )

  it('checks other stretches of border when one leaks on every try', () => {
    // A pillar hangs from y 7 to the base beside an overhang: many walls against it leak.
    const map = greenRects(160, [
      [0, 122, 159, 159],
      [141, 93, 159, 159],
      [68, 93, 141, 108],
      [41, 7, 49, 122],
    ])
    const plans = borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 0, charges: 60 })
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) {
      const outcome = simulateCapture(map, GREEN, plan)
      expect(outcome.refused).toBe(0)
      expect(outcome.gained).toBeGreaterThan(outcome.painted)
    }
  })

  it('ranks overlapping walls from different facings by what they enclose', () => {
    const map = greenRects(160, [
      [0, 140, 159, 159],
      [95, 77, 159, 159],
      [76, 23, 91, 140],
      [6, 77, 95, 105],
    ])
    const [plan] = borderBoxPlanner({ map, team: GREEN, painters: 4, guards: 0, charges: 60 })
    if (plan === undefined) throw new Error('Expected a plan')
    // A wall facing another way encloses 8,781 here; one found first encloses less.
    expect(simulateCapture(map, GREEN, plan).gained).toBeGreaterThanOrEqual(8781)
  })

  it('still proposes a wall whose overlapping rival loses to a wall on another facing', () => {
    // A top-facing wall over x 0 to 45 loses to a left-facing one from x 43; the top-facing wall
    // over x 0 to 42 overlaps neither and is still worth proposing.
    const map = greenRects(160, [
      [0, 111, 159, 159],
      [135, 0, 159, 131],
    ])
    const plans = borderBoxPlanner({ map, team: GREEN, painters: 3, guards: 0, charges: 60 })
    expect(plans.length).toBeGreaterThanOrEqual(2)
    for (const plan of plans) {
      const outcome = simulateCapture(map, GREEN, plan)
      expect(outcome.refused).toBe(0)
      expect(outcome.gained).toBeGreaterThan(outcome.painted)
    }
  })

  it('gives a wall apart from the first one a fill before more copies of the first', () => {
    // Two overlapping blocks stand on the base; most good walls crowd one notch between them.
    const map = greenRects(160, [
      [0, 107, 159, 159],
      [32, 27, 100, 114],
      [64, 12, 126, 97],
    ])
    const plans = borderBoxPlanner({ map, team: GREEN, painters: 4, guards: 0, charges: 60 })
    expect(plans.length).toBeGreaterThanOrEqual(2)
    for (const plan of plans) {
      const outcome = simulateCapture(map, GREEN, plan)
      expect(outcome.refused).toBe(0)
      expect(outcome.gained).toBeGreaterThan(outcome.painted)
    }
  })

  it('fills the waiting walls best estimate first, so a focused wall keeps its strongest form', () => {
    const map = greenRects(175, [
      [0, 134, 174, 174],
      [154, 45, 174, 86],
      [169, 45, 174, 134],
    ])
    const focus = { x: 39, y: 68 }
    const [plan] = borderBoxPlanner({
      map,
      team: GREEN,
      painters: 5,
      guards: 0,
      charges: 60,
      focus,
    })
    if (plan === undefined) throw new Error('Expected a plan')
    const outcome = simulateCapture(map, GREEN, plan)
    expect(outcome.refused).toBe(0)
    // Filled in round order, a weaker wall took the last fill and gained only 5,160.
    expect(outcome.gained).toBeGreaterThanOrEqual(17263)
  })

  it("starts each guard's zone beside the first pixel its painter places, on a slope", () => {
    const map = greenWhere(200, (x, y) => y >= 25 + x)
    const plans = borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 2, charges: 60 })
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans)
      plan.guardZones.forEach((zone, k) => {
        const start = plan.lines[k]?.[0] as ArenaPixel
        const first = zone[0] as ArenaPixel
        expect(Math.abs(first.x - start.x) + Math.abs(first.y - start.y)).toBe(1)
        for (const { x, y } of zone) expect(map.owner[y * 200 + x]).toBe(GREEN)
      })
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
    // 130 cells over three painters: 44 for the first, 43 for the others.
    expect(a2).toEqual(wall.slice(44, 87))
  })

  it('shares a short wall evenly, at most the charges each', () => {
    expect(pairLines(wall, 4, 60).map((line) => line.length)).toEqual([33, 33, 32, 32])
    expect(pairLines(wall.slice(0, 3), 4, 60).map((line) => line.length)).toEqual([1, 1, 1, 0])
    // The remainder goes one pixel at a time, so nobody is left out of a wall they could share.
    expect(pairLines(wall.slice(0, 17), 16, 60).map((line) => line.length)).toEqual([
      2,
      ...Array<number>(15).fill(1),
    ])
  })
})
