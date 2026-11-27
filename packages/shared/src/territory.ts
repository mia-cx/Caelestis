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

/** The arena pixel a world pixel is, or null outside the arena. */
export const worldToArena = ({ x, y }: ArenaPixel): ArenaPixel | null => {
  const local = {
    x: x - TERRITORY_ARENA.tileX * TILE_SIZE,
    y: y - TERRITORY_ARENA.tileY * TILE_SIZE,
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
 * The pixels a group paints, one line per painter in paint order. Painter 1's line starts against
 * the team's territory; each later line continues from the pixels before it, so every pixel is
 * placed next to territory the team already holds. The last line closes the loop.
 */
export interface CapturePlan {
  readonly lines: readonly (readonly ArenaPixel[])[]
}

/** What a planner is asked: the live map, whose side we are on, and the group's budget. */
export interface CaptureRequest {
  readonly map: TerritoryMap
  readonly team: TerritoryTeam
  readonly painters: number
  /** Pixels each painter places, at most `TERRITORY_CHARGES`. */
  readonly charges: number
}

/** Proposes plans for a request, best first. Any planner is scored the same way, by `simulateCapture`. */
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
  plan: CapturePlan,
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

/**
 * The strips that thicken a wall where it meets the team, one for each end. For each of the
 * `length` wall pixels nearest that end, the strip takes its neighbours on the enclosed side, in
 * an order the team can place before the wall exists, so a cut there has to go two pixels deep.
 */
export const anchorStrips = (
  map: TerritoryMap,
  team: TerritoryTeam,
  plan: CapturePlan,
  length: number,
): [ArenaPixel[], ArenaPixel[]] => {
  const { size } = map
  const wall = plan.lines.flat()
  const onWall = new Set(wall.map(({ x, y }) => y * size + x))
  const enclosed = simulateCapture(map, team, plan).map.owner
  const strip = (from: readonly ArenaPixel[]): ArenaPixel[] => {
    const owner = map.owner.slice()
    const chosen: ArenaPixel[] = []
    for (const { x, y } of from)
      for (const [dx, dy] of SIDES) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        const at = ny * size + nx
        if (onWall.has(at) || enclosed[at] !== team || owner[at] === team) continue
        if (!touches(owner, size, nx, ny, team) || chosen.length >= length) continue
        owner[at] = team
        chosen.push({ x: nx, y: ny })
      }
    return chosen
  }
  return [strip(wall.slice(0, length)), strip(wall.slice(-length).reverse())]
}

/** Split an ordered wall into consecutive lines of at most `charges` pixels each. */
export const splitWall = (wall: readonly ArenaPixel[], charges: number): CapturePlan => {
  const lines: ArenaPixel[][] = []
  for (let start = 0; start < wall.length; start += charges)
    lines.push(wall.slice(start, start + charges))
  return { lines }
}

/**
 * A rectangle out along one arena edge: from where the team's territory along that edge ends, a leg
 * along the edge, a long side back into the arena, and a return leg until it meets the team again.
 * The leg is a quarter of the budget and the long side half, the split that encloses the most for
 * a fixed wall when the team's border runs square to the edge. Pixels the team already holds cost
 * nothing, so the return leg may be shorter or longer than the outward one.
 */
const edgeWall = (
  map: TerritoryMap,
  team: TerritoryTeam,
  along: 'x' | 'y',
  budget: number,
): ArenaPixel[] | null => {
  const { size, owner } = map
  const { corner } = TERRITORY_TEAMS[team]
  const last = size - 1
  // The edge runs along `along` at the team's side of the other axis; walk it away from the corner.
  const fixed = along === 'x' ? (corner.y ? last : 0) : corner.x ? last : 0
  const step = (along === 'x' ? corner.x : corner.y) ? -1 : 1
  const inward = (along === 'x' ? corner.y : corner.x) ? -1 : 1
  const at = (s: number, t: number): ArenaPixel => (along === 'x' ? { x: s, y: t } : { x: t, y: s })
  const ownerAt = ({ x, y }: ArenaPixel) => owner[y * size + x]

  // The team's reach along the edge: its last pixel before another team's land begins. Unowned
  // gaps inside its own land do not end it.
  let held: number | null = null
  for (let along = step > 0 ? 0 : last; along >= 0 && along <= last; along += step) {
    const owner = ownerAt(at(along, fixed))
    if (owner === team) held = along
    else if (owner !== NO_TEAM) break
  }
  if (held === null) return null
  const frontier = held + step
  if (frontier < 0 || frontier > last) return null

  for (let side = Math.round(budget / 2); side > 1; side--) {
    const leg = Math.round((budget - side) / 2)
    const wall: ArenaPixel[] = []
    for (let i = 0; i < leg; i++) wall.push(at(frontier + i * step, fixed))
    const far = frontier + (leg - 1) * step
    if (far < 0 || far > last) continue
    for (let i = 1; i <= side; i++) wall.push(at(far, fixed + i * inward))
    const depth = fixed + side * inward
    if (depth < 0 || depth > last) continue
    let s = far - step
    let closed = false
    while (s >= 0 && s <= last && wall.length <= budget) {
      const pixel = at(s, depth)
      if (ownerAt(pixel) === team) {
        closed = true
        break
      }
      wall.push(pixel)
      s -= step
    }
    if (closed && wall.length <= budget) return wall
  }
  return null
}

/**
 * The starting planner: one rectangle along each arena edge at the team's corner, ranked by what
 * it gains. A better search replaces this by meeting the same `CapturePlanner` contract.
 */
export const edgeRectanglePlanner: CapturePlanner = ({ map, team, painters, charges }) => {
  const budget = painters * charges
  return (['x', 'y'] as const)
    .map((along) => edgeWall(map, team, along, budget))
    .filter((wall): wall is ArenaPixel[] => wall !== null)
    .map((wall) => splitWall(wall, charges))
    .map((plan) => ({ plan, gained: simulateCapture(map, team, plan).gained }))
    .sort((a, b) => b.gained - a.gained)
    .map(({ plan }) => plan)
}
