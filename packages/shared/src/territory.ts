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
 * A capture is a box set against the team's border: its inner side lies on territory the team
 * already holds, so only the other three sides are painted. Against a straight border the best box
 * is the half-square (legs a quarter of the budget, the long side half); next to an earlier claim
 * the same search fills the notch, and where the border bulges the box spends the pixels it saves
 * on longer legs.
 *
 * The defence is in the shape, so nothing is simulated while searching:
 * - Boxes score by what they enclose, scaled down while their `contact` (outline the team already
 *   holds, plus outline on the arena edge) is under three quarters of the budget. That is what an
 *   enemy must repaint to take the claim back whole, and three quarters is what a half-square with
 *   one leg on the canvas edge reaches, so edge boxes win without a special case.
 * - Corners an enemy can reach from two sides become 45° staircases of 24 steps: the same pixel
 *   count and about 300 px less area, and the worst bite one enemy painter can take falls from
 *   about 930 to 630. Corners on the arena edge are reachable from one side only and stay square.
 *
 * Every box costs O(1) through prefix sums, so the full arena searches in well under a second.
 */

/** A border starts where at least this many of the team's pixels run in a row. */
const SOLID = 8
/** Long-side lengths tried per facing, spaced geometrically from an eighth of the budget to 0.9. */
const SIDE_LENGTHS = 24
/** The share of the budget `contact` must reach for a box to score its full area. */
const CONTACT_TARGET = 0.75
/** The best boxes checked for an outline that closes into a wall. */
const KEEP = 40
/** Steps in a corner's 45° staircase. */
const CHAMFER = 24
/** Cells a guard's zone runs along the team's own border from an anchor. */
export const GUARD_MARGIN = 15
/** Proposals returned: the best few distinct boxes. */
const PROPOSALS = 3

type Facing = 'left' | 'right' | 'top' | 'bottom'

/** Prefix sums of the cells the team does not hold, which a box must paint or wins. */
interface NeedSums {
  readonly size: number
  /** Per row, running count along x: `row[y * (size + 1) + x]` counts cells before x. */
  readonly row: Int32Array
  /** Per column, running count along y. */
  readonly col: Int32Array
  /** Two-dimensional: `area[y * (size + 1) + x]` counts cells above y and left of x. */
  readonly area: Int32Array
}

const needSums = ({ size, owner }: TerritoryMap, team: TerritoryTeam): NeedSums => {
  const stride = size + 1
  const row = new Int32Array(size * stride)
  const col = new Int32Array(size * stride)
  const area = new Int32Array(stride * stride)
  for (let y = 0; y < size; y++) {
    let run = 0
    for (let x = 0; x < size; x++) {
      const need = owner[y * size + x] === team ? 0 : 1
      run += need
      row[y * stride + x + 1] = run
      col[x * stride + y + 1] = (col[x * stride + y] as number) + need
      area[(y + 1) * stride + x + 1] = (area[y * stride + x + 1] as number) + run
    }
  }
  return { size, row, col, area }
}

/** Outline cells of a box the team does not hold yet, corners counted once: what painters spend. */
const boxCost = (s: NeedSums, x0: number, y0: number, x1: number, y1: number): number => {
  const k = s.size + 1
  const r = s.row
  const c = s.col
  return (
    (r[y0 * k + x1 + 1] as number) -
    (r[y0 * k + x0] as number) +
    (r[y1 * k + x1 + 1] as number) -
    (r[y1 * k + x0] as number) +
    (c[x0 * k + y1] as number) -
    (c[x0 * k + y0 + 1] as number) +
    (c[x1 * k + y1] as number) -
    (c[x1 * k + y0 + 1] as number)
  )
}

/** Cells strictly inside a box the team does not hold yet: what closing it wins. */
const boxGain = (s: NeedSums, x0: number, y0: number, x1: number, y1: number): number => {
  if (x1 - x0 < 2 || y1 - y0 < 2) return 0
  const k = s.size + 1
  const a = s.area
  return (
    (a[y1 * k + x1] as number) -
    (a[y1 * k + x0 + 1] as number) -
    (a[(y0 + 1) * k + x1] as number) +
    (a[(y0 + 1) * k + x0 + 1] as number)
  )
}

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
 * The inner side's position for every window of `span` rows or columns: the profile's max over the
 * window facing left or up, its min facing right or down, so the side sits on the border all along.
 * Van Herk's block prefix and suffix make every window O(1). -1 where any row lacks a border.
 */
const slideBorder = (profile: Int32Array, span: number, takeMax: boolean): Int32Array => {
  const n = profile.length
  if (n < span) return new Int32Array(0)
  const fill = takeMax ? -1 : 1 << 30
  const pick = takeMax ? Math.max : Math.min
  const value = (i: number) =>
    i < n && (profile[i] as number) >= 0 ? (profile[i] as number) : fill
  const padded = Math.ceil(n / span) * span
  const pre = new Int32Array(padded)
  const suf = new Int32Array(padded)
  for (let i = 0; i < padded; i++)
    pre[i] = i % span === 0 ? value(i) : pick(pre[i - 1] as number, value(i))
  for (let i = padded - 1; i >= 0; i--)
    suf[i] = i % span === span - 1 ? value(i) : pick(suf[i + 1] as number, value(i))
  const inner = new Int32Array(n - span + 1)
  let gaps = 0
  for (let i = 0; i < span; i++) if ((profile[i] as number) < 0) gaps++
  for (let a = 0; a <= n - span; a++) {
    if (a > 0) {
      if ((profile[a - 1] as number) < 0) gaps--
      if ((profile[a + span - 1] as number) < 0) gaps++
    }
    inner[a] = gaps > 0 ? -1 : pick(suf[a] as number, pre[a + span - 1] as number)
  }
  return inner
}

interface Box {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** The box with its inner side at `inner`, legs of `leg` away from the team, over `span` lines from `a`. */
const placeBox = (
  facing: Facing,
  inner: number,
  a: number,
  span: number,
  leg: number,
  size: number,
): Box | null => {
  const outer = facing === 'left' || facing === 'top' ? inner - leg : inner + leg
  const lo = Math.max(0, Math.min(inner, outer))
  const hi = Math.min(size - 1, Math.max(inner, outer))
  if (hi - lo < 2) return null
  return facing === 'left' || facing === 'right'
    ? { x0: lo, y0: a, x1: hi, y1: a + span - 1 }
    : { x0: a, y0: lo, x1: a + span - 1, y1: hi }
}

interface Candidate extends Box {
  readonly score: number
  readonly contact: number
}

/** The best `KEEP` boxes the budget can pay for, and that hold `focus` when set, best first. */
const bestBoxes = (
  map: TerritoryMap,
  team: TerritoryTeam,
  budget: number,
  focus?: ArenaPixel,
): Candidate[] => {
  const { size } = map
  const sums = needSums(map, team)
  const profiles = borderProfiles(map, team)
  const sides = new Set<number>()
  for (let k = 0; k < SIDE_LENGTHS; k++)
    sides.add(Math.floor((budget / 8) * (0.9 * 8) ** (k / (SIDE_LENGTHS - 1))))
  const best: Candidate[] = []
  const consider = (box: Box | null) => {
    if (box === null) return
    const { x0, y0, x1, y1 } = box
    if (focus !== undefined && (focus.x < x0 || focus.x > x1 || focus.y < y0 || focus.y > y1))
      return
    const cost = boxCost(sums, x0, y0, x1, y1)
    if (cost <= 0 || cost > budget) return
    const outline = 2 * (x1 - x0 + y1 - y0)
    const edge =
      (x0 === 0 ? y1 - y0 : 0) +
      (x1 === size - 1 ? y1 - y0 : 0) +
      (y0 === 0 ? x1 - x0 : 0) +
      (y1 === size - 1 ? x1 - x0 : 0)
    const contact = outline - cost + edge
    const score = boxGain(sums, x0, y0, x1, y1) * Math.min(1, contact / (CONTACT_TARGET * budget))
    if (score <= 0 || (best.length === KEEP && score <= (best.at(-1) as Candidate).score)) return
    let at = best.length
    while (at > 0 && (best[at - 1] as Candidate).score < score) at--
    best.splice(at, 0, { ...box, score, contact })
    if (best.length > KEEP) best.pop()
  }
  for (const facing of ['left', 'right', 'top', 'bottom'] as const) {
    const takeMax = facing === 'left' || facing === 'top'
    for (const side of sides) {
      const span = side + 2
      const inner = slideBorder(profiles[facing], span, takeMax)
      const leg = Math.max(Math.floor((budget - side) / 2), 2)
      for (let a = 0; a < inner.length; a++) {
        const at = inner[a] as number
        if (at < 0) continue
        const box = placeBox(facing, at, a, span, leg, size)
        consider(box)
        if (box === null) continue
        // Where the real border saves pixels, spend them on longer legs.
        const spare = Math.max(
          0,
          Math.floor((budget - boxCost(sums, box.x0, box.y0, box.x1, box.y1)) / 2),
        )
        if (spare > 0) consider(placeBox(facing, at, a, span, leg + spare, size))
      }
    }
  }
  return best
}

/** A box's outline, clockwise from its top-left corner. */
const outlineOf = ({ x0, y0, x1, y1 }: Box): ArenaPixel[] => {
  const cells: ArenaPixel[] = []
  for (let x = x0; x <= x1; x++) cells.push({ x, y: y0 })
  for (let y = y0 + 1; y <= y1; y++) cells.push({ x: x1, y })
  for (let x = x1 - 1; x >= x0; x--) cells.push({ x, y: y1 })
  for (let y = y1 - 1; y > y0; y--) cells.push({ x: x0, y })
  return cells
}

const owns = (map: TerritoryMap, team: TerritoryTeam, { x, y }: ArenaPixel): boolean =>
  map.owner[y * map.size + x] === team

interface Outline {
  /** From anchor A to anchor B, the long way round. */
  readonly wall: ArenaPixel[]
  /** The inner side from beside anchor B to beside anchor A: the team's own cells. */
  readonly inner: ArenaPixel[]
}

/**
 * A box's outline split at its longest stretch of the team's cells, which is the inner side, into
 * that side and the wall; null when the outline is all or none of the team's. Specks of the team
 * elsewhere on the wall, as on a ragged border at the arena edge, stay in it for its shape and are
 * dropped before painting.
 */
const wallOf = (map: TerritoryMap, team: TerritoryTeam, box: Box): Outline | null => {
  const loop = outlineOf(box)
  const ours = loop.map((cell) => owns(map, team, cell))
  const n = loop.length
  let inner = 0
  let end = 0
  for (let i = 0, run = 0; i < 2 * n; i++) {
    run = ours[i % n] ? run + 1 : 0
    if (run > inner) [inner, end] = [run, i % n]
  }
  if (inner === 0 || inner >= n) return null
  const around = (from: number, length: number) =>
    Array.from({ length }, (_, k) => loop[(from + k) % n] as ArenaPixel)
  return { wall: around(end + 1, n - inner), inner: around(end - inner + 1 + n, inner) }
}

/**
 * Whether a closed wall holds `focus`: a four-connected walk from it, stepping over neither the
 * wall nor the inner side, cannot leave the box.
 */
const holds = (box: Box, closed: readonly ArenaPixel[], focus: ArenaPixel): boolean => {
  const width = box.x1 - box.x0 + 1
  const at = ({ x, y }: ArenaPixel) => (y - box.y0) * width + (x - box.x0)
  const seen = new Uint8Array(width * (box.y1 - box.y0 + 1))
  for (const cell of closed) seen[at(cell)] = 1
  if (seen[at(focus)] === 1) return true
  const queue = [focus]
  seen[at(focus)] = 1
  for (let head = 0; head < queue.length; head++) {
    const { x, y } = queue[head] as ArenaPixel
    for (const next of [
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 },
    ]) {
      if (next.x < box.x0 || next.x > box.x1 || next.y < box.y0 || next.y > box.y1) return false
      if (seen[at(next)] === 1) continue
      seen[at(next)] = 1
      queue.push(next)
    }
  }
  return true
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
 * The default planner: the best few distinct boxes against the team's border whose outline closes
 * into a wall, each chamfered where the budget allows, split into paired lines, with guard zones
 * along the inner side from each anchor. With a focus, a wall that does not hold it is skipped.
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
  const plans: CapturePlan[] = []
  const taken: Box[] = []
  for (const box of bestBoxes(map, team, budget, focus)) {
    if (plans.length === PROPOSALS) break
    if (taken.some((other) => overlaps(other, box))) continue
    const found = wallOf(map, team, box)
    if (found === null || found.wall.length < 2) continue
    const unpainted = (wall: readonly ArenaPixel[]) => wall.filter((cell) => !owns(map, team, cell))
    // A chamfer can trade the team's cells for ones to paint; keep the square wall past the budget.
    const chamfered = chamferWall(found.wall, map.size)
    const wall = unpainted(chamfered).length <= budget ? chamfered : found.wall
    if (focus !== undefined && !holds(box, [...wall, ...found.inner], focus)) continue
    const zones = [found.inner.slice(-GUARD_MARGIN).reverse(), found.inner.slice(0, GUARD_MARGIN)]
    const guardZones = guards === 0 ? [] : guards === 1 ? [zones.flat()] : zones
    plans.push({ lines: pairLines(unpainted(wall), painters, charges), guardZones })
    taken.push(box)
  }
  return plans
}
