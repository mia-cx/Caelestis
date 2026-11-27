import type { RgbaImage } from './png.js'
import { TILE_SIZE } from './tiles.js'

/**
 * Wplace's Territory Weekend event: four teams grow territory in one 2000 px arena.
 *
 * Rules, as the event explains them and as `simulateCapture` models them:
 *
 * - A painted pixel joins its team only when one of its four sides touches that team's territory.
 *   Diagonals do not connect.
 * - Territory that a team's pixels fully enclose becomes that team's, enemy territory included.
 *   The arena edge is not a wall: an area touching it is open.
 * - Territory cut off from the team's 250 px home base is lost.
 *
 * The constants come from Wplace's client config (`territory` in its bundle).
 */

/** Where the arena sits on the world canvas, and its side in pixels. */
export const TERRITORY_ARENA = { tileX: 635, tileY: 1027, size: 2000 } as const

/** When the event runs, in epoch milliseconds. */
export const TERRITORY_EVENT = {
  startsAt: Date.parse('2026-11-27T16:00:00Z'),
  endsAt: Date.parse('2026-11-27T16:00:00Z') + 72 * 3_600_000,
} as const

/** Whether the event is running at `now`. */
export const territoryEventLive = (now: number): boolean =>
  now >= TERRITORY_EVENT.startsAt && now < TERRITORY_EVENT.endsAt

/** Charges each painter holds when full: the most pixels one painter places in one go. */
export const TERRITORY_CHARGES = 60

/** The side of each team's starting base, in its corner of the arena. */
export const TERRITORY_HOME_SIZE = 250

/** In Wplace's team order. `colour` and `dark` are this package's palette indices. */
export const TERRITORY_TEAMS = [
  { key: 'blue', colour: 18, dark: 17, corner: { x: 0, y: 0 } },
  { key: 'orange', colour: 7, dark: 34, corner: { x: 1, y: 0 } },
  { key: 'green', colour: 12, dark: 11, corner: { x: 1, y: 1 } },
  { key: 'purple', colour: 23, dark: 22, corner: { x: 0, y: 1 } },
] as const

export type TerritoryTeam = 0 | 1 | 2 | 3

/** An arena pixel no team holds. */
export const NO_TEAM = 255

/** Who holds each arena pixel, row by row: a team index, or `NO_TEAM`. */
export interface TerritoryMap {
  readonly size: number
  readonly owner: Uint8Array
}

/** A pixel in arena coordinates, 0 to `size - 1` from the arena's top-left corner. */
export interface ArenaPixel {
  readonly x: number
  readonly y: number
}

/** The world pixel an arena pixel is. */
export const arenaToWorld = ({ x, y }: ArenaPixel): ArenaPixel => ({
  x: TERRITORY_ARENA.tileX * TILE_SIZE + x,
  y: TERRITORY_ARENA.tileY * TILE_SIZE + y,
})

/**
 * The arena pixel a world point falls in, or null outside the arena. A fractional point, such as
 * the view's centre, lands on the whole pixel under it.
 */
export const worldToArena = ({ x, y }: ArenaPixel): ArenaPixel | null => {
  const local = {
    x: Math.floor(x) - TERRITORY_ARENA.tileX * TILE_SIZE,
    y: Math.floor(y) - TERRITORY_ARENA.tileY * TILE_SIZE,
  }
  const inside = (value: number) => value >= 0 && value < TERRITORY_ARENA.size
  return inside(local.x) && inside(local.y) ? local : null
}

/**
 * Read Wplace's `/territory/snapshot` image, decoded to RGBA, into owners. Each team shows in its
 * colour or its dark shade; anything else, transparent included, is no team.
 */
export const territoryMapFromImage = (
  image: RgbaImage,
  palette: ReadonlyArray<readonly [number, number, number]>,
): TerritoryMap => {
  const teamOf = new Map<number, TerritoryTeam>()
  TERRITORY_TEAMS.forEach((team, index) => {
    for (const entry of [team.colour, team.dark]) {
      const rgb = palette[entry]
      if (rgb !== undefined)
        teamOf.set((rgb[0] << 16) | (rgb[1] << 8) | rgb[2], index as TerritoryTeam)
    }
  })
  const owner = new Uint8Array(image.width * image.height).fill(NO_TEAM)
  const { pixels } = image
  for (let at = 0; at < owner.length; at++) {
    const offset = at * 4
    if ((pixels[offset + 3] ?? 0) === 0) continue
    const key =
      ((pixels[offset] ?? 0) << 16) | ((pixels[offset + 1] ?? 0) << 8) | (pixels[offset + 2] ?? 0)
    owner[at] = teamOf.get(key) ?? NO_TEAM
  }
  return { size: image.width, owner }
}

/**
 * The pixels a group paints, one line per painter in paint order, and each guard's zone. Painters
 * go in pairs from the wall's two anchors: lines 1 and 2 start against the territory at anchors A
 * and B, and every later line continues from the line two before it, so each pixel is placed next
 * to territory the team holds when its turn comes. The last one or two lines close the middle.
 */
export interface CapturePlan {
  readonly lines: readonly (readonly ArenaPixel[])[]
  /** Per guard, the team's own cells just past an anchor: free to draft, and what they repair. */
  readonly guardZones: readonly (readonly ArenaPixel[])[]
}

/** What a planner is asked: the live map, whose side we are on, and the group's budget. */
export interface CaptureRequest {
  readonly map: TerritoryMap
  readonly team: TerritoryTeam
  /** Painters who build the wall; guards are counted separately. */
  readonly painters: number
  /** Anchor guards, 0 to 2. */
  readonly guards: number
  /** Pixels each painter places, at most `TERRITORY_CHARGES`. */
  readonly charges: number
  /** When set, only boxes holding this arena pixel are proposed. */
  readonly focus?: ArenaPixel
}

/**
 * Proposes plans for a request, best first. The planner's shape is its defence; `simulateCapture`
 * only confirms that a proposal closes.
 */
export type CapturePlanner = (request: CaptureRequest) => readonly CapturePlan[]

/** What painting a plan in order would do to the map. */
export interface CaptureOutcome {
  /** Pixels that joined the team when painted. */
  readonly painted: number
  /** Pixels already the team's, which the plan need not paint. */
  readonly held: number
  /** Pixels that touch no territory when their turn comes, so Wplace would refuse them. */
  readonly refused: number
  /** Territory the team holds afterwards minus before, enclosure and lost islands included. */
  readonly gained: number
  readonly map: TerritoryMap
}

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

const touches = (owner: Uint8Array, size: number, x: number, y: number, team: number): boolean =>
  SIDES.some(([dx, dy]) => {
    const nx = x + dx
    const ny = y + dy
    return nx >= 0 && ny >= 0 && nx < size && ny < size && owner[ny * size + nx] === team
  })

const countTeam = (owner: Uint8Array, team: number): number => {
  let count = 0
  for (const value of owner) if (value === team) count++
  return count
}

/**
 * Fill outward from every non-team pixel on the arena edge, through non-team pixels in all eight
 * directions: a team wall stops the fill only where its pixels share sides. What the fill never
 * reaches is enclosed and becomes the team's.
 */
const enclose = (owner: Uint8Array, size: number, team: number): void => {
  const open = new Uint8Array(owner.length)
  const stack: number[] = []
  const seed = (at: number) => {
    if (open[at] === 1 || owner[at] === team) return
    open[at] = 1
    stack.push(at)
  }
  for (let i = 0; i < size; i++) {
    seed(i)
    seed((size - 1) * size + i)
    seed(i * size)
    seed(i * size + size - 1)
  }
  while (stack.length > 0) {
    const at = stack.pop() as number
    const x = at % size
    const y = (at - x) / size
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && ny >= 0 && nx < size && ny < size) seed(ny * size + nx)
      }
  }
  for (let at = 0; at < owner.length; at++) if (open[at] === 0) owner[at] = team
}

/** Drop the team's territory that no longer reaches its home corner through shared sides. */
const dropIslands = (owner: Uint8Array, size: number, team: TerritoryTeam): void => {
  const { corner } = TERRITORY_TEAMS[team]
  const home = (corner.y ? size - 1 : 0) * size + (corner.x ? size - 1 : 0)
  if (owner[home] !== team) return
  const linked = new Uint8Array(owner.length)
  const stack = [home]
  linked[home] = 1
  while (stack.length > 0) {
    const at = stack.pop() as number
    const x = at % size
    const y = (at - x) / size
    for (const [dx, dy] of SIDES) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const next = ny * size + nx
      if (linked[next] === 1 || owner[next] !== team) continue
      linked[next] = 1
      stack.push(next)
    }
  }
  for (let at = 0; at < owner.length; at++)
    if (owner[at] === team && linked[at] === 0) owner[at] = NO_TEAM
}

/** Paint a plan in order on a copy of the map, then apply enclosure and the home-link rule. */
export const simulateCapture = (
  map: TerritoryMap,
  team: TerritoryTeam,
  plan: Pick<CapturePlan, 'lines'>,
): CaptureOutcome => {
  const { size } = map
  const owner = map.owner.slice()
  const before = countTeam(owner, team)
  let painted = 0
  let held = 0
  let refused = 0
  for (const line of plan.lines)
    for (const { x, y } of line) {
      const at = y * size + x
      if (owner[at] === team) held++
      else if (touches(owner, size, x, y, team)) {
        owner[at] = team
        painted++
      } else refused++
    }
  enclose(owner, size, team)
  dropIslands(owner, size, team)
  return { painted, held, refused, gained: countTeam(owner, team) - before, map: { size, owner } }
}

/*
 * The border-box planner.
 *
 * A capture is a wall set against the team's border: a straight far side, and two legs that run
 * from its ends back to the team's territory, each along its own row or column. Each leg ends where
 * it meets the border, so on a slanted or stepped border the legs differ in length and the claim
 * hugs the real border; where the far side runs into the territory itself, that leg is empty.
 * Against a straight border the best wall is the half-square (legs a quarter of the budget, the far
 * side half); next to an earlier claim the same search fills the notch, and where the border bulges
 * the far side crosses it for free.
 *
 * The defence is in the shape, so nothing is simulated while searching:
 * - Walls score by what they enclose, scaled down while their `contact` (the border between the
 *   anchors, wall the team already holds, and wall on the arena edge) is under three quarters of
 *   the budget. That is what an enemy must repaint to take the claim back whole, and three quarters
 *   is what a half-square with one leg on the canvas edge reaches, so edge walls win without a
 *   special case.
 * - Corners an enemy can reach from two sides become 45° staircases of 24 steps: the same pixel
 *   count and about 300 px less area, and the worst bite one enemy painter can take falls from
 *   about 930 to 630. Corners on the arena edge are reachable from one side only and stay square.
 *
 * Every candidate costs O(1) through prefix sums, so the full arena searches in well under a
 * second. Up to `KEEP` candidates are then filled within their own bounds to count what they
 * enclose, best estimate first and one per stretch of border each round. Of the walls that close
 * and hold the focus, the best enclosure goes first and each later one is kept unless it overlaps
 * one already kept.
 */

/** A border starts where at least this many of the team's pixels run in a row. */
const SOLID = 8
/** Far-side lengths tried per facing, spaced geometrically from an eighth of the budget to 0.9. */
const SIDE_LENGTHS = 24
/** The share of the budget `contact` must reach for a wall to score its full area. */
const CONTACT_TARGET = 0.75
/** The most candidates filled to count what they enclose. */
const KEEP = 40
/** Steps in a corner's 45° staircase. */
const CHAMFER = 24
/** The area one chamfered corner gives up. */
const CHAMFER_CUT = (CHAMFER * (CHAMFER + 1)) / 2
/**
 * Cells in a guard's zone: from the team's cell beside the first pixel its painter places, along
 * the team's own border, or along the territory that an empty leg's far side meets.
 */
export const GUARD_MARGIN = 15
/** Proposals returned: the best few distinct walls. */
const PROPOSALS = 3

type Facing = 'left' | 'right' | 'top' | 'bottom'

/**
 * Where the team's solid territory starts along every row (left, right) and column (top, bottom):
 * the first or last cell of a run of at least `SOLID`. -1 where a row or column has none.
 */
const borderProfiles = (
  { size, owner }: TerritoryMap,
  team: TerritoryTeam,
): Record<Facing, Int32Array> => {
  const profiles = {
    left: new Int32Array(size).fill(-1),
    right: new Int32Array(size).fill(-1),
    top: new Int32Array(size).fill(-1),
    bottom: new Int32Array(size).fill(-1),
  }
  const scan = (line: number, at: (i: number) => number, first: Int32Array, last: Int32Array) => {
    let run = 0
    for (let i = 0; i < size; i++) {
      run = owner[at(i)] === team ? run + 1 : 0
      if (run < SOLID) continue
      if (first[line] === -1) first[line] = i - SOLID + 1
      last[line] = i
    }
  }
  for (let y = 0; y < size; y++) scan(y, (x) => y * size + x, profiles.left, profiles.right)
  for (let x = 0; x < size; x++) scan(x, (y) => y * size + x, profiles.top, profiles.bottom)
  return profiles
}

/**
 * One facing of the team's border, turned so the team lies deeper: lines run along the border (rows
 * facing left or right, columns facing up or down), and depth runs from the arena edge in front of
 * the border towards the team.
 */
interface Front {
  /** Per line, the depth where the team's solid territory starts; -1 where the line has none. */
  readonly border: Int32Array
  /** The arena pixel at a line and depth. */
  readonly cell: (line: number, depth: number) => ArenaPixel
  /** A pixel's line and depth. */
  readonly locate: (pixel: ArenaPixel) => readonly [number, number]
  /** Cells the team does not hold in lines `l0` to `l1` and depths `d0` to `d1`, ends excluded. */
  readonly need: (l0: number, l1: number, d0: number, d1: number) => number
}

/** The team's four fronts, sharing one prefix sum of the cells the team does not hold. */
const frontsOf = (map: TerritoryMap, team: TerritoryTeam): Front[] => {
  const { size, owner } = map
  const k = size + 1
  // `sums[y * k + x]` counts the cells above y and left of x that the team does not hold.
  const sums = new Int32Array(k * k)
  for (let y = 0; y < size; y++) {
    let run = 0
    for (let x = 0; x < size; x++) {
      run += owner[y * size + x] === team ? 0 : 1
      sums[(y + 1) * k + x + 1] = (sums[y * k + x + 1] as number) + run
    }
  }
  const rect = (x0: number, x1: number, y0: number, y1: number) =>
    (sums[y1 * k + x1] as number) -
    (sums[y0 * k + x1] as number) -
    (sums[y1 * k + x0] as number) +
    (sums[y0 * k + x0] as number)
  const profiles = borderProfiles(map, team)
  const last = size - 1
  const flip = (profile: Int32Array) => profile.map((at) => (at < 0 ? -1 : last - at))
  return [
    {
      border: profiles.left,
      cell: (line, depth) => ({ x: depth, y: line }),
      locate: ({ x, y }) => [y, x],
      need: (l0, l1, d0, d1) => rect(d0, d1, l0, l1),
    },
    {
      border: flip(profiles.right),
      cell: (line, depth) => ({ x: last - depth, y: line }),
      locate: ({ x, y }) => [y, last - x],
      need: (l0, l1, d0, d1) => rect(size - d1, size - d0, l0, l1),
    },
    {
      border: profiles.top,
      cell: (line, depth) => ({ x: line, y: depth }),
      locate: ({ x, y }) => [x, y],
      need: (l0, l1, d0, d1) => rect(l0, l1, d0, d1),
    },
    {
      border: flip(profiles.bottom),
      cell: (line, depth) => ({ x: line, y: last - depth }),
      locate: ({ x, y }) => [x, last - y],
      need: (l0, l1, d0, d1) => rect(l0, l1, size - d1, size - d0),
    },
  ]
}

/** A wall on one front: leg A on line `from`, leg B on line `to`, the far side at depth `far`. */
interface Candidate {
  readonly front: Front
  readonly from: number
  readonly to: number
  readonly far: number
  /** `contact` over its target, at most 1: the share of what it encloses a wall scores. */
  readonly reach: number
  readonly score: number
}

/** Every wall the budget can pay for that may hold `focus` when set, best estimate first. */
const bestWalls = (
  map: TerritoryMap,
  team: TerritoryTeam,
  budget: number,
  focus?: ArenaPixel,
): Candidate[] => {
  const { size } = map
  const spans = new Set<number>()
  for (let k = 0; k < SIDE_LENGTHS; k++)
    spans.add(Math.floor((budget / 8) * (0.9 * 8) ** (k / (SIDE_LENGTHS - 1))) + 2)
  const found: Candidate[] = []
  for (const front of frontsOf(map, team)) {
    const { border, need } = front
    // Running counts per line: lines without a border, cells in front of the border, and how far
    // the border steps in depth from the line before.
    const gaps = new Int32Array(size + 1)
    const ahead = new Int32Array(size + 1)
    const steps = new Int32Array(size)
    for (let line = 0; line < size; line++) {
      const at = border[line] as number
      const before = line === 0 ? -1 : (border[line - 1] as number)
      gaps[line + 1] = (gaps[line] as number) + (at < 0 ? 1 : 0)
      ahead[line + 1] = (ahead[line] as number) + (at < 0 ? 0 : need(line, line + 1, 0, at))
      if (line > 0)
        steps[line] =
          (steps[line - 1] as number) + (at < 0 || before < 0 ? 0 : Math.abs(at - before))
    }
    const [focusLine, focusDepth] = focus === undefined ? [-1, -1] : front.locate(focus)
    /** Score one wall and keep it if it ranks; returns its cost, or -1 when it does not fit. */
    const consider = (from: number, to: number, far: number): number => {
      const a = border[from] as number
      const b = border[to] as number
      // A leg is empty where the far side meets the team's territory on that line itself.
      const fits = (line: number, depth: number) =>
        far < depth || need(line, line + 1, far, far + 1) === 0
      if (far >= Math.max(a, b) || !fits(from, a) || !fits(to, b)) return -1
      const legA = Math.max(0, a - far)
      const legB = Math.max(0, b - far)
      // The corners `chamferWall` will cut: away from the edge, with `CHAMFER` straight cells on
      // the leg and on the far side, past corner A's staircase for corner B. Neither may cut the
      // focus out.
      const cutA = legA > CHAMFER && to - from >= CHAMFER && far > 0 && from > 0
      const cutB =
        legB > CHAMFER && to - from >= (cutA ? 2 : 1) * CHAMFER && far > 0 && to < size - 1
      const near = (end: number) => Math.abs(focusLine - end) + focusDepth - far <= CHAMFER
      // The focus may lie on the wall itself; the fill after the search confirms it is held.
      if (
        focus !== undefined &&
        (focusLine < from ||
          focusLine > to ||
          focusDepth < far ||
          focusDepth >= (border[focusLine] as number) ||
          (cutA && near(from)) ||
          (cutB && near(to)))
      )
        return -1
      const cost =
        (legA > 0 ? need(from, from + 1, far, a) : 0) +
        (legB > 0 ? need(to, to + 1, far, b) : 0) +
        need(from + 1, to, far, far + 1)
      if (cost <= 0 || cost > budget) return -1
      // On every line between the legs, what lies from the far side to the border, less what the
      // chamfered corners give up.
      const gain =
        (ahead[to] as number) -
        (ahead[from + 1] as number) -
        need(from + 1, to, 0, far + 1) -
        (Number(cutA) + Number(cutB)) * CHAMFER_CUT
      const length = legA + legB + to - from - 1
      const edge =
        (far === 0 ? to - from - 1 : 0) + (from === 0 ? legA : 0) + (to === size - 1 ? legB : 0)
      // The border's length from anchor A to anchor B, the wall's cells the team holds, the edge.
      const held = to - from + (steps[to] as number) - (steps[from] as number)
      const contact = held + length - cost + edge
      const reach = Math.min(1, contact / (CONTACT_TARGET * budget))
      const score = gain * reach
      if (score > 0) found.push({ front, from, to, far, reach, score })
      return cost
    }
    for (const span of spans)
      for (let from = 0; from + span <= size; from++) {
        const to = from + span - 1
        if (gaps[to + 1] !== gaps[from]) continue
        // The far side sits where legs that end on the border at their own lines spend the budget.
        // Past the nearer border that leg is empty, and the other spends it all.
        const a = border[from] as number
        const b = border[to] as number
        const legs = budget - (span - 2)
        const even = Math.ceil((a + b - legs) / 2)
        const far = Math.max(0, even < Math.min(a, b) ? even : Math.max(a, b) - legs)
        const cost = consider(from, to, far)
        // The team's specks on the wall cost nothing; spend what they save on longer legs.
        const spare = Math.floor((budget - cost) / 2)
        if (cost >= 0 && far > 0 && spare > 0) consider(from, to, Math.max(0, far - spare))
      }
  }
  return found.sort((a, b) => b.score - a.score)
}

/**
 * A candidate's wall from anchor A to anchor B: out along leg A, the far side, back along leg B. An
 * empty leg leaves the team's own cell at that end of the far side, which is never painted.
 */
const wallOf = ({ front, from, to, far }: Candidate): ArenaPixel[] => {
  const { border, cell } = front
  const wall: ArenaPixel[] = []
  for (let depth = (border[from] as number) - 1; depth > far; depth--) wall.push(cell(from, depth))
  for (let line = from; line <= to; line++) wall.push(cell(line, far))
  for (let depth = far + 1; depth < (border[to] as number); depth++) wall.push(cell(to, depth))
  return wall
}

interface Box {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** The box around a candidate's claim: its lines, from the far side to the deepest border. */
const boundsOf = ({ front, from, to, far }: Candidate): Box => {
  let deepest = 0
  for (let line = from; line <= to; line++)
    deepest = Math.max(deepest, front.border[line] as number)
  const a = front.cell(from, far)
  const b = front.cell(to, deepest)
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  }
}

const owns = (map: TerritoryMap, team: TerritoryTeam, { x, y }: ArenaPixel): boolean =>
  map.owner[y * map.size + x] === team

const OPEN = 1
const WALL = 2

/**
 * What a wall encloses within `bounds`, which hold the wall and the border it closes against. A fill
 * from the bounds' rim, through cells neither the team's nor the wall's in all eight directions,
 * marks what stays open. Any way out of the bounds crosses the rim, so the rest is enclosed exactly.
 * Returns the cells the team would win, and whether a pixel ends up the team's.
 */
const enclosure = (
  map: TerritoryMap,
  team: TerritoryTeam,
  bounds: Box,
  wall: readonly ArenaPixel[],
): { readonly won: number; readonly holds: (pixel: ArenaPixel) => boolean } => {
  const { x0, y0, x1, y1 } = bounds
  const width = x1 - x0 + 1
  const index = (x: number, y: number) => (y - y0) * width + x - x0
  const state = new Uint8Array(width * (y1 - y0 + 1))
  for (const { x, y } of wall) state[index(x, y)] = WALL
  const stack: number[] = []
  const seed = (x: number, y: number) => {
    const at = index(x, y)
    if (state[at] !== 0 || owns(map, team, { x, y })) return
    state[at] = OPEN
    stack.push(at)
  }
  for (let x = x0; x <= x1; x++) {
    seed(x, y0)
    seed(x, y1)
  }
  for (let y = y0; y <= y1; y++) {
    seed(x0, y)
    seed(x1, y)
  }
  while (stack.length > 0) {
    const at = stack.pop() as number
    const x = x0 + (at % width)
    const y = y0 + Math.floor(at / width)
    for (let ny = Math.max(y0, y - 1); ny <= Math.min(y1, y + 1); ny++)
      for (let nx = Math.max(x0, x - 1); nx <= Math.min(x1, x + 1); nx++) seed(nx, ny)
  }
  let won = 0
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) if (state[index(x, y)] === 0 && !owns(map, team, { x, y })) won++
  const holds = ({ x, y }: ArenaPixel) =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1 && state[index(x, y)] !== OPEN
  return { won, holds }
}

/**
 * Turn every exposed corner of a wall into a 45° staircase. A corner qualifies with `CHAMFER`
 * straight cells on both sides and neither neighbour on the arena edge; from `CHAMFER` cells
 * before it, the staircase steps once in the new direction and once in the old, `CHAMFER` times,
 * ending where the straight wall did, so the pixel count stays the same.
 */
export const chamferWall = (wall: readonly ArenaPixel[], size: number): ArenaPixel[] => {
  const out = [...wall]
  const step = (j: number) => {
    const a = out[j - 1] as ArenaPixel
    const b = out[j] as ArenaPixel
    return { x: b.x - a.x, y: b.y - a.y }
  }
  const same = (a: ArenaPixel, b: ArenaPixel) => a.x === b.x && a.y === b.y
  const onEdge = ({ x, y }: ArenaPixel) => x === 0 || y === 0 || x === size - 1 || y === size - 1
  let i = CHAMFER
  while (i < out.length - CHAMFER) {
    const into = step(i)
    const away = step(i + 1)
    let straight =
      !same(into, away) && !onEdge(out[i - 1] as ArenaPixel) && !onEdge(out[i + 1] as ArenaPixel)
    for (let j = i - CHAMFER + 1; straight && j <= i; j++) straight = same(step(j), into)
    for (let j = i + 1; straight && j <= i + CHAMFER; j++) straight = same(step(j), away)
    if (!straight) {
      i++
      continue
    }
    let { x, y } = out[i - CHAMFER] as ArenaPixel
    const stairs: ArenaPixel[] = [{ x, y }]
    for (let k = 0; k < CHAMFER; k++) {
      x += away.x
      y += away.y
      stairs.push({ x, y })
      x += into.x
      y += into.y
      stairs.push({ x, y })
    }
    out.splice(i - CHAMFER, 2 * CHAMFER + 1, ...stairs)
    i += CHAMFER + 1
  }
  return out
}

/**
 * The wall as one line per painter, in pairs from both anchors: A-lines take the next cells inward
 * from A, B-lines the next from B, reversed so each starts beside the line before it. The wall is
 * shared evenly, at most `charges` each, so a short wall still gives every painter a part. Always
 * `painters` lines; only a wall shorter than the group leaves some empty.
 */
export const pairLines = (
  wall: readonly ArenaPixel[],
  painters: number,
  charges: number,
): ArenaPixel[][] => {
  // Every painter takes the even share, and the first few one pixel more for the remainder.
  const base = Math.floor(wall.length / painters)
  const extra = wall.length % painters
  const lines: ArenaPixel[][] = []
  let lo = 0
  let hi = wall.length
  for (let k = 0; k < painters; k++) {
    const share = Math.min(charges, base + (k < extra ? 1 : 0))
    if (k % 2 === 0) {
      lines.push(wall.slice(lo, Math.min(lo + share, hi)))
      lo = Math.min(lo + share, hi)
    } else {
      lines.push(wall.slice(Math.max(hi - share, lo), hi).reverse())
      hi = Math.max(hi - share, lo)
    }
  }
  return lines
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1

/**
 * The default planner: the best few distinct walls against the team's border, each chamfered where
 * the budget allows and ranked by what it encloses, split into paired lines, with guard zones on
 * the team's cells beside each anchor. With a focus, a wall that does not hold it is skipped.
 */
export const borderBoxPlanner: CapturePlanner = ({
  map,
  team,
  painters,
  guards,
  charges,
  focus,
}) => {
  const budget = painters * charges
  const unpainted = (wall: readonly ArenaPixel[]) => wall.filter((cell) => !owns(map, team, cell))
  const walls: { candidate: Candidate; wall: ArenaPixel[]; bounds: Box; score: number }[] = []
  const filled: Candidate[] = []
  // Fills go round the stretches of border, best estimate first: each round, every stretch gets
  // one more, so near-copies of one wall cannot use them all, and a stretch that leaks keeps its
  // fallbacks.
  let pending = bestWalls(map, team, budget, focus)
  for (let round = 0; pending.length > 0 && filled.length < KEEP; round++) {
    const later: Candidate[] = []
    for (const candidate of pending) {
      if (filled.length === KEEP) break
      const shared = filled.filter(
        (other) =>
          other.front === candidate.front &&
          other.from <= candidate.to &&
          candidate.from <= other.to,
      ).length
      if (shared > round) {
        later.push(candidate)
        continue
      }
      filled.push(candidate)
      const bounds = boundsOf(candidate)
      const square = wallOf(candidate)
      // A chamfer can trade the team's cells for ones to paint; keep the square wall past the
      // budget.
      const chamfered = chamferWall(square, map.size)
      const wall = unpainted(chamfered).length <= budget ? chamfered : square
      const { won, holds } = enclosure(map, team, bounds, wall)
      if (won > 0 && (focus === undefined || holds(focus)))
        walls.push({ candidate, wall, bounds, score: won * candidate.reach })
    }
    pending = later
  }
  // Best enclosure first, each wall kept unless it overlaps one already kept.
  walls.sort((a, b) => b.score - a.score)
  const chosen: typeof walls = []
  for (const wall of walls)
    if (chosen.length < PROPOSALS && !chosen.some((other) => overlaps(other.bounds, wall.bounds)))
      chosen.push(wall)
  return chosen.map(({ candidate, wall }) => {
    const { front, from, to, far } = candidate
    const { border, cell } = front
    // The border along the first lines from the anchor; past an empty leg, the territory the far
    // side meets, deeper along that line.
    const along = (end: number, inward: number) =>
      far >= (border[end] as number)
        ? Array.from({ length: Math.min(GUARD_MARGIN, map.size - far) }, (_, k) =>
            cell(end, far + k),
          ).filter((pixel) => owns(map, team, pixel))
        : Array.from({ length: Math.min(GUARD_MARGIN, to - from + 1) }, (_, k) => {
            const line = end + inward * k
            return cell(line, border[line] as number)
          })
    // Where the wall's end crosses the team's cells, the painter starts past them: the zone starts
    // on the owned cell beside that first pixel and runs back over them to the end.
    const zone = (end: readonly ArenaPixel[], inward: number) => {
      const first = end.findIndex((pixel) => !owns(map, team, pixel))
      const crossed = end.slice(0, Math.max(0, first)).reverse()
      const seen = new Set(crossed.map(({ x, y }) => y * map.size + x))
      const rest = along(inward > 0 ? from : to, inward).filter(
        ({ x, y }) => !seen.has(y * map.size + x),
      )
      return [...crossed, ...rest].slice(0, GUARD_MARGIN)
    }
    const zones = [zone(wall, 1), zone([...wall].reverse(), -1)]
    const guardZones = guards === 0 ? [] : guards === 1 ? [zones.flat()] : zones
    return { lines: pairLines(unpainted(wall), painters, charges), guardZones }
  })
}
