import type { TerritoryTeam } from '@caelestis/shared'

/**
 * This painter's Wplace event team, once read; null until then. Presence reports it to event
 * servers, and an event-runner invite redeemed on one binds its token to it.
 */
let team: TerritoryTeam | null = null

export const eventTeam = (): TerritoryTeam | null => team

export const rememberEventTeam = (next: TerritoryTeam | null): void => {
  team = next
}
