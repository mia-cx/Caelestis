import {
  type ArenaPixel,
  arenaToWorld,
  borderBoxPlanner,
  decodePng,
  NO_TEAM,
  PALETTE_RGB,
  type RegionShapePixels,
  simulateCapture,
  TERRITORY_CHARGES,
  TERRITORY_TEAMS,
  type TerritoryMap,
  type TerritoryTeam,
  territoryMapFromImage,
} from '@caelestis/shared'
import { enclosedArea } from './capture-scene.js'

/**
 * One planning pass, from Wplace's snapshot bytes to proposals an administrator can publish. It
 * imports nothing from the page, so the planner worker and the inline fallback run the same code.
 */

export interface PlanRequest {
  /** `/territory/snapshot`, as Wplace served it. */
  readonly snapshot: Uint8Array
  readonly team: TerritoryTeam
  readonly painters: number
  readonly guards: number
}

export interface PlannedProposal {
  /** What it reads as, e.g. "Into purple, on the canvas edge". */
  readonly label: string
  readonly gained: number
  readonly pixels: number
  /** The wall's lines in paint order, then each guard's zone, as flat world coordinates. */
  readonly lines: readonly (readonly number[])[]
  readonly area: RegionShapePixels | null
}

const toWorld = (line: readonly ArenaPixel[]): number[] =>
  line.flatMap((pixel) => {
    const world = arenaToWorld(pixel)
    return [world.x, world.y]
  })

/** The team a wall mostly cuts into, and whether it runs along the canvas edge. */
const proposalLabel = (map: TerritoryMap, wall: readonly ArenaPixel[]): string => {
  const counts = new Map<number, number>()
  let edge = false
  const last = map.size - 1
  for (const { x, y } of wall) {
    const owner = map.owner[y * map.size + x] as number
    counts.set(owner, (counts.get(owner) ?? 0) + 1)
    edge ||= x === 0 || y === 0 || x === last || y === last
  }
  const [enemy] =
    [...counts].filter(([owner]) => owner !== NO_TEAM).sort((a, b) => b[1] - a[1])[0] ?? []
  const name =
    enemy === undefined
      ? 'open ground'
      : (TERRITORY_TEAMS[enemy as TerritoryTeam]?.key ?? 'open ground')
  return `Into ${name}${edge ? ', on the canvas edge' : ''}`
}

/**
 * Plan from a snapshot. The planner's shape is its defence; one simulation per plan only confirms
 * that it closes, and serves its score and hatched area.
 */
export const planProposals = async ({
  snapshot,
  team,
  painters,
  guards,
}: PlanRequest): Promise<PlannedProposal[]> => {
  const map = territoryMapFromImage(await decodePng(snapshot), PALETTE_RGB)
  const plans = borderBoxPlanner({ map, team, painters, guards, charges: TERRITORY_CHARGES })
  return plans.flatMap((plan) => {
    const outcome = simulateCapture(map, team, plan)
    if (outcome.refused > 0 || outcome.gained <= 0) return []
    const wall = plan.lines.map(toWorld)
    return [
      {
        label: proposalLabel(map, plan.lines.flat()),
        gained: outcome.gained,
        pixels: outcome.painted,
        lines: [...wall, ...plan.guardZones.map(toWorld)],
        area: enclosedArea(map, team, wall, outcome.map),
      },
    ]
  })
}
