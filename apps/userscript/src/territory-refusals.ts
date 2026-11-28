import { isRecord } from '@caelestis/shared'
import { warn } from './debug.js'
import { type WplaceLabel, wplaceLabel } from './wplace-messages.js'
import { findWplaceModules } from './wplace-modules.js'

/**
 * A refused territory-event paint keeps its draft, so the painter's next Paint tap submits it again.
 *
 * The event's Paint panel sends its draft over the territory socket, not as a `/paint` request, and
 * the server refuses pixels inside a successful answer: `{ painted, refused, reason }`. Wplace's
 * panel shows the reason and then clears the whole draft. It keeps the draft only when the paint
 * call throws. So when the answer refuses pixels, the store's `paint` rejects with Wplace's own
 * message for the reason, and Wplace's error path shows it and leaves the draft as it is.
 *
 * Caelestis never writes the draft. A draft the painter cancels or changes meanwhile stays as they
 * left it. Pawtect cannot see the wrapper: no event is dispatched and no response is altered.
 * Territory Weekend only; this module goes with the rest of the event support after 30 November 2026.
 */

/** What the territory server answers a paint with, summed over Wplace's batches. */
export interface TerritoryPaintResult {
  readonly painted: number
  readonly refused: number
  readonly reason?: string
}

/** Wplace's territory store: the one object the event panel paints through. */
export interface TerritoryStore {
  paint(pixels: unknown): Promise<TerritoryPaintResult>
}

/** The reason Wplace leaves unreported: pixels the team already holds cost nothing. */
const OWN = 'own'

/** Wplace's message for each reason a paint can be refused; it falls back to not-adjacent too. */
const REFUSAL_MESSAGES: Readonly<Record<string, WplaceLabel>> = {
  'not-adjacent': 'territory_not_adjacent',
  'enemy-home': 'territory_enemy_home',
  'no-charges': 'no_more_charges',
  outside: 'territory_stay_in_arena',
}

/**
 * Make `store.paint` reject whenever Wplace would report a refusal, so its panel keeps the draft.
 * Shadows the prototype method on the instance, which is the object Wplace's panel calls.
 */
export const keepRefusedDrafts = (store: TerritoryStore): void => {
  const paint = store.paint.bind(store)
  store.paint = async (pixels) => {
    const result = await paint(pixels)
    if (!result.reason || result.reason === OWN) return result
    throw new Error(wplaceLabel(REFUSAL_MESSAGES[result.reason] ?? 'territory_not_adjacent'))
  }
}

const isTerritoryStore = (value: unknown): value is TerritoryStore =>
  isRecord(value) &&
  ['paint', 'swap', 'sentByMe'].every((method) => typeof value[method] === 'function')

/** Find Wplace's territory store and keep its refused drafts. */
export const installTerritoryRefusals = async (): Promise<void> => {
  try {
    const found = await findWplaceModules({
      territory: (source) => source.includes('PUBLIC_TERRITORY_URL') && source.includes('sentByMe'),
    })
    const store = Object.values(found.territory?.module ?? {}).find(isTerritoryStore)
    if (store === undefined) throw new Error('territory store not found')
    keepRefusedDrafts(store)
  } catch (error) {
    warn('refused territory drafts will be cleared', String(error))
  }
}
