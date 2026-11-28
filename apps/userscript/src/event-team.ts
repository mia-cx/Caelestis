import type { TerritoryTeam } from '@caelestis/shared'
import { observePageRequests, type RequestRoute } from './page-requests.js'
import { pageWindow } from './page-world.js'
import { BACKEND_ORIGIN } from './wplace-raster.js'

/** How long Wplace gets to answer a team lookup before it counts as failed. */
const TEAM_LOOKUP_MS = 5_000

const LEADERBOARD_PATH = '/territory/leaderboard'

/**
 * This painter's Wplace event team, once read; null until then. Event servers share presence and
 * capture runs within a team.
 */
let team: TerritoryTeam | null = null

/** The team as last read, without asking Wplace. */
export const eventTeam = (): TerritoryTeam | null => team

/** The team in a leaderboard body: its `me` row, present only for a signed-in painter with a team. */
const teamIn = (body: unknown): TerritoryTeam | null => {
  const read = (body as { me?: { team?: unknown } } | null)?.me?.team
  return read === 0 || read === 1 || read === 2 || read === 3 ? read : null
}

/**
 * Read this painter's team from Wplace's own leaderboard, until it is known. Null means Wplace
 * answered and the painter has no team; a failed lookup throws.
 *
 * The request goes through the page's `fetch`, not this script's: in a userscript manager's sandbox
 * the script's own `fetch` can go out without Wplace's session cookie, and Wplace then answers as if
 * nobody were signed in, with no `me` at all.
 */
export const readEventTeam = async (): Promise<TerritoryTeam | null> => {
  if (team !== null) return team
  const response = await pageWindow().fetch(`${BACKEND_ORIGIN}${LEADERBOARD_PATH}`, {
    credentials: 'include',
    signal: AbortSignal.timeout(TEAM_LOOKUP_MS),
  })
  if (!response.ok) throw new Error(`territory leaderboard ${response.status}`)
  // Lookups can overlap; a late answer from before the painter joined never undoes a known team.
  team ??= teamIn(await response.json())
  return team
}

/** Wplace's own leaderboard reads, every ten seconds while its event panel is open, carry the team too. */
const leaderboardRoute: RequestRoute = (request) => {
  if (request.url.origin !== BACKEND_ORIGIN || request.url.pathname !== LEADERBOARD_PATH) return
  if (!request.isGet()) return
  return {
    response: (response) => {
      if (response.ok)
        void response
          .clone()
          .json()
          .then((body) => {
            team ??= teamIn(body)
          })
          .catch(() => undefined)
      return response
    },
  }
}

/** Follow Wplace's own leaderboard reads for the team. Install once. */
export const installEventTeam = (): void => {
  observePageRequests(leaderboardRoute)
}
