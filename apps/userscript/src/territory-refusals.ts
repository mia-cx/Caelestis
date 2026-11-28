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

/** One socket answer from the territory server; a paint's carries that batch's result. */
export interface TerritoryAnswer {
  readonly result?: { readonly reason?: string }
}

/** A socket request Wplace's store sends; a paint batch carries its pixels as `[x, y]` pairs. */
export interface TerritoryRequest {
  readonly t?: unknown
  readonly pixels?: unknown
}

/**
 * Wplace's territory store: the one object the event panel paints through. `paint` sends the draft
 * in batches, each one a `request`, and sums them, keeping only the last batch's reason.
 */
export interface TerritoryStore {
  paint(pixels: unknown): Promise<TerritoryPaintResult>
  request(message: TerritoryRequest): Promise<TerritoryAnswer>
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
 * Make `store.paint` reject whenever any of its own batches is refused for a reason other than own,
 * so Wplace's panel keeps the draft. The summed result alone can't tell: a later batch of owned
 * pixels hides an earlier refusal, so each batch's answer is read as it arrives.
 *
 * A batch carries no mark of the submission it belongs to, and a painter can cancel a pending
 * paint and submit another. So submissions go one at a time: a new one starts once the one before
 * it is answered, and every paint batch in flight belongs to the one running. Shadows the
 * prototype methods on the instance, which is what Wplace calls.
 */
export const keepRefusedDrafts = (store: TerritoryStore): void => {
  const paint = store.paint.bind(store)
  const request = store.request.bind(store)
  /** The refusals of the submission now sending, or null between submissions. */
  let running: string[] | null = null
  let previous: Promise<unknown> = Promise.resolve()
  store.request = async (message) => {
    const refusals = message.t === 'paint' ? running : null
    const answer = await request(message)
    const reason = answer.result?.reason
    if (reason && reason !== OWN) refusals?.push(reason)
    return answer
  }
  store.paint = (pixels) => {
    const submitted = previous.then(async () => {
      const refusals: string[] = []
      running = refusals
      try {
        const result = await paint(pixels)
        const [reason] = refusals
        if (reason === undefined) return result
        throw new Error(wplaceLabel(REFUSAL_MESSAGES[reason] ?? 'territory_not_adjacent'))
      } finally {
        running = null
      }
    })
    previous = submitted.catch(() => undefined)
    return submitted
  }
}

const isTerritoryStore = (value: unknown): value is TerritoryStore =>
  isRecord(value) &&
  ['paint', 'request', 'swap', 'sentByMe'].every((method) => typeof value[method] === 'function')

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
