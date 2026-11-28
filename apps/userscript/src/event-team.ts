import type { TerritoryTeam } from '@caelestis/shared'
import { observePageRequests, type RequestRoute } from './page-requests.js'
import { pageWindow } from './page-world.js'
import { observeTerritorySocket, type TerritoryMessage } from './territory-socket.js'
import { accountIdentity } from './wplace-account.js'
import { BACKEND_ORIGIN } from './wplace-raster.js'

/** How long Wplace gets to answer a team lookup before it counts as failed. */
const TEAM_LOOKUP_MS = 5_000

const LEADERBOARD_PATH = '/territory/leaderboard'

/**
 * This painter's Wplace event team, once read; null until then. Event servers share presence and
 * capture runs within a team.
 */
let team: TerritoryTeam | null = null

/** Whether Wplace's territory socket last greeted this signed-in painter with no team. */
let unjoined = false

/** The team as last read, without asking Wplace. */
export const eventTeam = (): TerritoryTeam | null => team

/**
 * Whether Wplace says this signed-in painter has not joined the event: its event panel then offers
 * Join, and they have no team until they press it.
 */
export const eventTeamUnjoined = (): boolean => team === null && unjoined

const asTeam = (value: unknown): TerritoryTeam | null =>
  value === 0 || value === 1 || value === 2 || value === 3 ? value : null

interface LeaderboardRow {
  readonly id?: unknown
  readonly team?: unknown
}

/**
 * The team in a leaderboard body: the painter's `me` row, or their own row in `top` or `teamTop`.
 * Wplace leaves `me` empty for a painter already in the top 10, as its own event panel expects.
 */
const teamIn = (body: unknown): TerritoryTeam | null => {
  const board = body as { me?: LeaderboardRow | null; top?: unknown; teamTop?: unknown } | null
  const own = asTeam(board?.me?.team)
  if (own !== null) return own
  const id = accountIdentity()?.wplaceUserId
  if (id === undefined) return null
  const rows = [board?.top, board?.teamTop].flatMap((list) =>
    Array.isArray(list) ? (list as (LeaderboardRow | null)[]) : [],
  )
  return asTeam(rows.find((row) => row?.id === id)?.team)
}

/**
 * Read this painter's team from Wplace's own leaderboard, until it is known. Null means Wplace
 * answered without the painter's team; a failed lookup throws.
 *
 * The request goes through the page's `fetch`, not this script's: in a userscript manager's sandbox
 * the script's own `fetch` can go out without Wplace's session cookie, and Wplace then answers as if
 * nobody were signed in, with no `me` at all.
 */
export const readEventTeam = async (): Promise<TerritoryTeam | null> => {
  if (team !== null) return team
  try {
    return await askLeaderboard()
  } catch (error) {
    // The socket or Wplace's own reads may have carried the team while this lookup failed.
    if (team !== null) return team
    throw error
  }
}

const askLeaderboard = async (): Promise<TerritoryTeam | null> => {
  // The signal comes from the page too: a page fetch can refuse one from another realm.
  const page = pageWindow()
  const response = await page.fetch(`${BACKEND_ORIGIN}${LEADERBOARD_PATH}`, {
    credentials: 'include',
    signal: page.AbortSignal.timeout(TEAM_LOOKUP_MS),
  })
  if (!response.ok) throw new Error(`territory leaderboard ${response.status}`)
  // Read before assigning: `??=` checks `team` first, so a team found while this body was still
  // parsing would be overwritten. A late answer from before the painter joined never undoes it.
  const read = teamIn(await response.json())
  team ??= read
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

/**
 * Wplace's territory socket messages that carry the painter's `me`: the `hello` that opens every
 * connection, the reply to Join, and the reply to each paint, under `result`. Its scoreboard shows
 * the team from these, for every painter on a team, ranked or not.
 */
const onTerritoryMessage = (message: TerritoryMessage): void => {
  if (team !== null) return
  const me = (message.me ?? (message.result as { me?: unknown } | undefined)?.me) as
    | { team?: unknown }
    | null
    | undefined
  team ??= asTeam(me?.team)
  if (message.t === 'hello') unjoined = message.authed === true && message.me === null
}

/**
 * Follow Wplace's own territory socket and leaderboard reads for the team. Install once, with the
 * page hooks, before Wplace opens its socket: one opened earlier is never observed.
 */
export const installEventTeam = (): void => {
  observeTerritorySocket({ received: onTerritoryMessage })
  observePageRequests(leaderboardRoute)
}
