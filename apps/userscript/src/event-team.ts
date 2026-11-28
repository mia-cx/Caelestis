import type { TerritoryTeam } from '@caelestis/shared'
import { BACKEND_ORIGIN } from './wplace-raster.js'

/** How long Wplace gets to answer a team lookup before it counts as failed. */
const TEAM_LOOKUP_MS = 5_000

/**
 * This painter's Wplace event team, once read; null until then. Event servers share presence and
 * capture runs within a team.
 */
let team: TerritoryTeam | null = null

/** The team as last read, without asking Wplace. */
export const eventTeam = (): TerritoryTeam | null => team

/**
 * Read this painter's team from Wplace's own leaderboard, until it is known. Null means Wplace
 * answered and the painter has no team; a failed lookup throws.
 */
export const readEventTeam = async (): Promise<TerritoryTeam | null> => {
  if (team !== null) return team
  const response = await fetch(`${BACKEND_ORIGIN}/territory/leaderboard`, {
    credentials: 'include',
    signal: AbortSignal.timeout(TEAM_LOOKUP_MS),
  })
  if (!response.ok) throw new Error(`territory leaderboard ${response.status}`)
  const body: unknown = await response.json()
  const read = (body as { me?: { team?: unknown } } | null)?.me?.team
  // Lookups can overlap; a late answer from before the painter joined never undoes a known team.
  team ??= read === 0 || read === 1 || read === 2 || read === 3 ? read : null
  return team
}
